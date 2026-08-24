/**
 * Router role configuration
 * Multi-WAN gateway with recursive-route failover, NAT, DHCP server and DNS.
 *
 * Unlike the WAP roles, this role KEEPS router functions. lib/configure.js
 * deliberately strips them (DHCP servers, NAT, static IPs, DNS) because a WAP
 * sits behind someone else's router. A router role must do the opposite.
 *
 * Object ownership is expressed through comments:
 *   - routes            "wan:<name> probe" / "wan:<name> default"
 *   - NAT rules         "router:masquerade"
 *   - filter rules      "router:<purpose>"
 *   - pool / server     "router:lan"
 * Re-applying finds objects by those comments and replaces them, so a second
 * run is a no-op and hand-added objects are left alone.
 */

const dns = require('dns').promises;

const { MikroTikSSH } = require('./ssh-client');
const {
  setDeviceIdentity,
  ensureBridgeInfrastructure,
  configureIgmpSnooping,
  configureSyslog,
  detectWifiPackage,
  execIdempotent,
  execWithWarning
} = require('./infrastructure');
const { getWifiPath } = require('./utils');
const { q, must, ifaceName, ipv4, cidr, ipRange, duration, integer, ipv4List, IDENTIFIER } = require('./routeros-args');
const { CHANNEL_FREQ_24GHZ, CHANNEL_FREQ_5GHZ } = require('./constants');
const { detectRadioLayout, detectBandToken, configureWifiInterface } = require('./wifi-config');

const WAN_LIST = 'WAN';
const LAN_LIST = 'LAN';
const LAN_POOL = 'lan-pool';
const LAN_DHCP = 'lan-dhcp';

// Probe targets handed out when a WAN does not name its own.
const DEFAULT_PROBES = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222'];

/* ------------------------------------------------------------------ */
/* Address helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Convert a dotted-quad IPv4 address to a 32-bit unsigned integer.
 * @param {string} ip
 * @returns {number|null}
 */
function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

/**
 * Convert a 32-bit unsigned integer to a dotted-quad IPv4 address.
 * @param {number} value
 * @returns {string}
 */
function intToIp(value) {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

/**
 * Split "192.168.80.1/24" into its address and prefix length.
 * @param {string} cidr
 * @returns {{address: string, prefix: number}|null}
 */
function parseCidr(cidr) {
  const match = String(cidr || '').trim().match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!match) return null;
  const prefix = parseInt(match[2], 10);
  if (ipToInt(match[1]) === null || prefix < 0 || prefix > 32) return null;
  return { address: match[1], prefix };
}

/**
 * Test whether an address falls inside a CIDR range.
 * Used to avoid deleting the address we are currently connected through.
 * @param {string} ip
 * @param {string} cidr
 * @returns {boolean}
 */
function cidrContains(ip, cidr) {
  const parsed = parseCidr(cidr);
  const target = ipToInt(ip);
  if (!parsed || target === null) return false;
  const base = ipToInt(parsed.address);
  if (parsed.prefix === 0) return true;
  const mask = (0xFFFFFFFF << (32 - parsed.prefix)) >>> 0;
  return ((base & mask) >>> 0) === ((target & mask) >>> 0);
}

/**
 * Network address of a CIDR, e.g. "192.168.80.1/24" -> "192.168.80.0/24".
 * The DHCP server network entry must be the network, not the host address.
 * @param {string} cidr
 * @returns {string|null}
 */
function networkOf(cidr) {
  const parsed = parseCidr(cidr);
  if (!parsed) return null;
  const mask = parsed.prefix === 0 ? 0 : (0xFFFFFFFF << (32 - parsed.prefix)) >>> 0;
  return `${intToIp((ipToInt(parsed.address) & mask) >>> 0)}/${parsed.prefix}`;
}

/**
 * Derive a sensible DHCP pool from the LAN CIDR when none is configured.
 * Uses .100 through .200 of the network for a /24 or wider.
 * @param {string} cidr
 * @returns {string|null}
 */
function defaultPoolFor(cidr) {
  const parsed = parseCidr(cidr);
  if (!parsed || parsed.prefix > 24) return null;
  const mask = (0xFFFFFFFF << (32 - parsed.prefix)) >>> 0;
  const base = (ipToInt(parsed.address) & mask) >>> 0;
  return `${intToIp(base + 100)}-${intToIp(base + 200)}`;
}

/**
 * Resolve the host this session connected to into an IPv4 address.
 *
 * `config.host` is routinely an FQDN in this project - device identity is
 * derived from it. Feeding an FQDN straight into an address comparison silently
 * yields "no match", which would defeat the guard that keeps the tool from
 * deleting the address carrying its own session.
 *
 * @param {string} host - IP address or hostname
 * @returns {Promise<string|null>} - IPv4 address, or null if it cannot be resolved
 */
async function resolveHostAddress(host) {
  if (!host) return null;
  if (ipToInt(host) !== null) return host;

  try {
    const { address } = await dns.lookup(host, { family: 4 });
    console.log(`✓ Resolved ${host} to ${address}`);
    return address;
  } catch (e) {
    console.log(`⚠️  Could not resolve ${host}: ${e.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* WAN normalisation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fill in defaults and ordering for the configured WAN links.
 * Lower distance wins, so the list is sorted by distance for display.
 * @param {Array<Object>} wanConfig
 * @returns {Array<Object>}
 */
function normalizeWans(wanConfig = []) {
  const ordered = wanConfig.map((wan, index) => ({
    name: wan.name || `wan${index + 1}`,
    interface: wan.interface,
    type: wan.type || 'dhcp',
    distance: wan.distance !== undefined ? wan.distance : index + 1,
    probe: wan.probe,
    apn: wan.apn,
    address: wan.address,
    gateway: wan.gateway,
    user: wan.user,
    password: wan.password
  })).sort((a, b) => a.distance - b.distance);

  // Assign default probes after sorting, so the most preferred uplink gets the
  // first target. Assigning before would let the order they were typed in
  // decide, which reads as arbitrary in the config that gets backed up.
  const taken = new Set(ordered.map(w => w.probe).filter(Boolean));
  let next = 0;
  for (const wan of ordered) {
    if (wan.probe) continue;
    while (next < DEFAULT_PROBES.length && taken.has(DEFAULT_PROBES[next])) next++;
    // Reusing a probe address would put two /32 routes on the same
    // destination with different gateways, and the recursive lookup would
    // follow whichever won - silently disabling failover for those uplinks.
    if (next >= DEFAULT_PROBES.length) {
      throw new Error(
        `Ran out of default probe addresses at uplink "${wan.name}". ` +
        `Set an explicit unique "probe" on each uplink beyond the first ${DEFAULT_PROBES.length}.`
      );
    }

    wan.probe = DEFAULT_PROBES[next];
    taken.add(wan.probe);
    next++;
  }

  return ordered;
}

/**
 * Build the comment stored on a WAN interface-list member.
 * This is how an uplink's settings survive the link being down.
 * @param {Object} wan - One normalised WAN link
 * @returns {string}
 */
function wanMemberComment(wan) {
  const parts = [`wan:${wan.name}`, `type=${wan.type}`, `distance=${wan.distance}`, `probe=${wan.probe}`];
  if (wan.apn) parts.push(`apn=${wan.apn}`);
  if (wan.gateway) parts.push(`gateway=${wan.gateway}`);
  return parts.join(' ');
}

/**
 * Parse a WAN interface-list member comment back into settings.
 * @param {string} comment
 * @returns {Object|null}
 */
function parseWanMemberComment(comment) {
  if (!comment) return null;
  const nameMatch = comment.match(/^wan:(\S+)/);
  if (!nameMatch) return null;

  const link = { name: nameMatch[1] };
  for (const [, key, value] of comment.matchAll(/(\w+)=(\S+)/g)) {
    if (key === 'distance') {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) link.distance = n;
    } else if (['type', 'probe', 'apn', 'gateway'].includes(key)) {
      link[key] = value;
    }
  }
  return link;
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

/**
 * Maintain the WAN and LAN interface lists.
 *
 * RouterOS interface lists let one NAT rule and one firewall rule cover every
 * uplink, however many there are. The device's own default config already
 * works this way, so the router role follows the same convention.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Array<Object>} wans - Normalised WAN links
 * @returns {boolean} - True when the LAN list contains the bridge
 */
async function configureInterfaceLists(mt, wans) {
  console.log('\n=== Configuring Interface Lists ===');

  for (const list of [WAN_LIST, LAN_LIST]) {
    await execIdempotent(
      mt,
      `/interface list add name=${list}`,
      `Interface list ${list} present`,
      ['already have', 'exists']
    );
  }

  // Rebuild membership from scratch. Removing only the interfaces named in the
  // current config would leave a deleted uplink's member behind forever, and
  // because these comments are the authoritative record for backup, that
  // uplink would reappear on the next backup and get re-applied.
  try {
    await mt.exec(`/interface list member remove [find list=${WAN_LIST} comment~"^wan:"]`);
  } catch (e) { /* none present */ }
  for (const wan of wans) {
    try {
      await mt.exec(`/interface list member remove [find list=${WAN_LIST} interface=${ifaceName(wan.interface)}]`);
    } catch (e) { /* not a member yet */ }
  }
  try {
    await mt.exec(`/interface list member remove [find list=${LAN_LIST} interface=bridge]`);
  } catch (e) { /* not a member yet */ }

  for (const wan of wans) {
    // This comment is the authoritative record of the uplink's settings.
    // Routes only exist while a link is up, so reading settings back from
    // them would lose an unplugged uplink entirely. The list member is always
    // there.
    await execWithWarning(
      mt,
      `/interface list member add list=${WAN_LIST} interface=${ifaceName(wan.interface)} ` +
        `comment=${q(wanMemberComment(wan))}`,
      `${wan.interface} added to ${WAN_LIST} list`,
      `Could not add ${wan.interface} to ${WAN_LIST}`
    );
  }

  await execWithWarning(
    mt,
    `/interface list member add list=${LAN_LIST} interface=bridge`,
    `bridge added to ${LAN_LIST} list`,
    `Could not add bridge to ${LAN_LIST}`
  );

  // The input-chain drop rule trusts this list. Verify before relying on it.
  try {
    const members = await mt.exec(`/interface list member print where list=${LAN_LIST}`);
    if (members.includes('bridge')) {
      console.log(`✓ Verified: bridge is in the ${LAN_LIST} list`);
      return true;
    }
    console.log(`⚠️  bridge is NOT in the ${LAN_LIST} list - firewall drop rule will be skipped`);
    return false;
  } catch (e) {
    console.log(`⚠️  Could not verify ${LAN_LIST} membership: ${e.message}`);
    return false;
  }
}

/**
 * Put the LAN ports on the bridge and take the WAN ports off it.
 * A routed uplink must not be a bridge port, or its traffic would be switched
 * onto the LAN instead of routed.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} lan - LAN configuration block
 * @param {Array<Object>} wans - Normalised WAN links
 */
async function configureLanBridge(mt, lan, wans) {
  console.log('\n=== Configuring LAN Bridge ===');

  for (const wan of wans) {
    try {
      const existing = await mt.exec(`/interface bridge port print terse where interface=${ifaceName(wan.interface)}`);
      if (existing && existing.trim()) {
        await mt.exec(`/interface bridge port remove [find interface=${ifaceName(wan.interface)}]`);
        console.log(`✓ Removed ${wan.interface} from bridge (it is a routed uplink)`);
      }
    } catch (e) {
      console.log(`⚠️  Could not remove ${wan.interface} from bridge: ${e.message}`);
    }
  }

  const ports = lan.ports || [];
  for (const port of ports) {
    await execIdempotent(
      mt,
      `/interface bridge port add bridge=bridge interface=${ifaceName(port, 'lan.ports entry')}`,
      `${port} on bridge`,
      ['already have interface']
    );
    await execWithWarning(
      mt,
      `/interface ethernet set [find default-name=${ifaceName(port, 'lan.ports entry')}] disabled=no`,
      `${port} enabled`,
      `Could not enable ${port}`
    );
  }

  // The LAN address is static, so a DHCP client on the bridge would fight it.
  try {
    const clients = await mt.exec('/ip dhcp-client print terse where interface=bridge');
    if (clients && clients.trim()) {
      await mt.exec('/ip dhcp-client remove [find interface=bridge]');
      console.log('✓ Removed DHCP client from bridge (LAN address is static)');
    }
  } catch (e) { /* none present */ }
}

/**
 * Bring up each uplink according to its type.
 *
 * Every type is created with add-default-route=no and use-peer-dns=no.
 * The tool owns the default routes and the resolver list; letting the ISP
 * inject either would break failover in ways that are hard to see.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Array<Object>} wans - Normalised WAN links
 */
async function configureWanLinks(mt, wans) {
  console.log('\n=== Configuring WAN Links ===');

  for (const wan of wans) {
    console.log(`\n--- ${wan.name} (${wan.interface}, ${wan.type}) ---`);

    if (wan.type === 'dhcp') {
      try {
        await mt.exec(`/ip dhcp-client remove [find interface=${ifaceName(wan.interface)}]`);
      } catch (e) { /* none present */ }
      await execWithWarning(
        mt,
        `/ip dhcp-client add interface=${ifaceName(wan.interface)} add-default-route=no ` +
          `use-peer-dns=no use-peer-ntp=no disabled=no comment=${q(`wan:${wan.name}`)}`,
        `DHCP client on ${wan.interface}`,
        `Could not add DHCP client on ${wan.interface}`
      );
      await execWithWarning(
        mt,
        `/interface ethernet set [find default-name=${ifaceName(wan.interface)}] disabled=no`,
        `${wan.interface} enabled`,
        `Could not enable ${wan.interface}`
      );

    } else if (wan.type === 'static') {
      if (!wan.address) {
        console.log(`⚠️  ${wan.name}: type is static but no address given, skipping`);
        continue;
      }
      // Remove only the address this tool owns. Wiping every static address on
      // the interface would take out a secondary public address or one owned by
      // another service.
      try {
        await mt.exec(`/ip address remove [find interface=${ifaceName(wan.interface)} comment=${q(`wan:${wan.name}`)}]`);
      } catch (e) { /* none present */ }
      await execWithWarning(
        mt,
        `/ip address add address=${cidr(wan.address, `${wan.name} address`)} interface=${ifaceName(wan.interface)} comment=${q(`wan:${wan.name}`)}`,
        `Static address ${wan.address} on ${wan.interface}`,
        `Could not set static address on ${wan.interface}`
      );
      await execWithWarning(
        mt,
        `/interface ethernet set [find default-name=${ifaceName(wan.interface)}] disabled=no`,
        `${wan.interface} enabled`,
        `Could not enable ${wan.interface}`
      );

    } else if (wan.type === 'pppoe') {
      try {
        await mt.exec(`/interface pppoe-client remove [find name=${q(`pppoe-${wan.name}`)}]`);
      } catch (e) { /* none present */ }
      await execWithWarning(
        mt,
        `/interface pppoe-client add name=${q(`pppoe-${wan.name}`)} interface=${ifaceName(wan.interface)} ` +
          `user=${q(wan.user || '')} password=${q(wan.password || '')} ` +
          `add-default-route=no use-peer-dns=no disabled=no comment=${q(`wan:${wan.name}`)}`,
        `PPPoE client pppoe-${wan.name} on ${wan.interface}`,
        `Could not add PPPoE client on ${wan.interface}`
      );

    } else if (wan.type === 'lte') {
      // The APN profile carries add-default-route. Left at its default it
      // injects a modem route that competes with the failover routes.
      const profile = `apn-${wan.name}`;
      const apnParams = [
        `name=${q(profile)}`,
        'add-default-route=no',
        'use-peer-dns=no'
      ];
      if (wan.apn) {
        apnParams.push(`apn=${q(wan.apn)}`, 'use-network-apn=no');
      } else {
        apnParams.push('use-network-apn=yes');
      }

      try {
        await mt.exec(`/interface lte apn remove [find name=${q(profile)}]`);
      } catch (e) { /* none present */ }
      await execWithWarning(
        mt,
        `/interface lte apn add ${apnParams.join(' ')}`,
        `APN profile ${profile}${wan.apn ? ` (apn=${wan.apn})` : ' (network-supplied APN)'}`,
        `Could not create APN profile ${profile}`
      );
      await execWithWarning(
        mt,
        `/interface lte set [find name=${ifaceName(wan.interface)}] apn-profiles=${q(profile)} disabled=no`,
        `${wan.interface} using ${profile}`,
        `Could not attach APN profile to ${wan.interface}`
      );

    } else {
      console.log(`⚠️  ${wan.name}: unknown type "${wan.type}", skipping`);
    }
  }
}

/**
 * Find the next hop for one uplink.
 *
 * Point-to-point links (LTE, PPPoE) have no useful gateway address, so the
 * interface name is used directly. DHCP leases carry a gateway that has to be
 * read back from the device after the lease binds.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} wan - One normalised WAN link
 * @returns {string|null} - Gateway address or interface name
 */
async function resolveWanGateway(mt, wan) {
  if (wan.type === 'lte') return wan.interface;
  if (wan.type === 'pppoe') return `pppoe-${wan.name}`;
  if (wan.type === 'static') return wan.gateway || null;

  try {
    const detail = await mt.exec(`/ip dhcp-client print detail where interface=${ifaceName(wan.interface)}`);
    const match = detail.match(/gateway=(\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
    console.log(`⚠️  ${wan.name}: DHCP lease has no gateway yet (is the cable connected?)`);
  } catch (e) {
    console.log(`⚠️  ${wan.name}: could not read DHCP gateway: ${e.message}`);
  }
  return null;
}

/**
 * Write the recursive failover routes.
 *
 * Each uplink gets a probe route pinning one address to that uplink, plus a
 * default route whose gateway is that probe address. RouterOS resolves the
 * default route through the probe route, and check-gateway=ping tests the
 * whole path to the internet rather than just the first hop. A modem that has
 * lost its uplink still answers pings on its LAN side, which is exactly the
 * failure a first-hop check misses.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Array<Object>} wans - Normalised WAN links
 */
function gwArg(gateway) {
  // A gateway is either an IPv4 next hop (DHCP, static) or a point-to-point
  // interface name (LTE, PPPoE). Both go in unquoted, so both must be checked.
  return /^\d/.test(gateway) ? ipv4(gateway, 'gateway') : ifaceName(gateway, 'gateway interface');
}

async function configureFailoverRoutes(mt, wans) {
  console.log('\n=== Configuring Failover Routes ===');

  // Resolve every gateway BEFORE removing anything. Clearing the routes first
  // and then discovering a link is down would strip that uplink's routes with
  // nothing to put back, turning an apply during an outage into a worse outage.
  const resolved = [];
  for (const wan of wans) {
    resolved.push({ wan, gateway: await resolveWanGateway(mt, wan) });
  }

  const usable = resolved.filter(r => r.gateway);
  if (usable.length === 0) {
    console.log('✗ No uplink has a resolvable gateway, so the existing routes are left untouched.');
    console.log('    Removing them would leave the router with no default route at all.');
    for (const { wan } of resolved) {
      console.log(`    ${wan.name} (${wan.interface}): no gateway - is the link up?`);
    }
    return;
  }

  for (const { wan, gateway } of resolved) {
    if (!gateway) {
      console.log(`⚠️  ${wan.name}: no gateway available, its routes are left as they are`);
      console.log('    Re-run apply once the link is up.');
      continue;
    }

    // Replace only this uplink's routes, so a down uplink keeps whatever it had.
    try {
      await mt.exec(`/ip route remove [find comment~${q(`^wan:${wan.name} `)}]`);
    } catch (e) { /* none present */ }

    await execWithWarning(
      mt,
      `/ip route add dst-address=${ipv4(wan.probe, `${wan.name} probe`)}/32 gateway=${gwArg(gateway)} scope=10 ` +
        `comment=${q(`wan:${wan.name} probe`)}`,
      `${wan.name}: probe ${wan.probe} pinned to ${gateway}`,
      `${wan.name}: could not add probe route`
    );

    await execWithWarning(
      mt,
      `/ip route add dst-address=0.0.0.0/0 gateway=${ipv4(wan.probe, `${wan.name} probe`)} target-scope=11 ` +
        `distance=${integer(wan.distance, `${wan.name} distance`)} check-gateway=ping comment=${q(`wan:${wan.name} default`)}`,
      `${wan.name}: default route via ${wan.probe} at distance ${wan.distance}`,
      `${wan.name}: could not add default route`
    );
  }
}

/**
 * Masquerade traffic leaving any uplink.
 * One rule covers every WAN because it matches the interface list.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 */
async function configureNat(mt) {
  console.log('\n=== Configuring NAT ===');

  try {
    await mt.exec('/ip firewall nat remove [find comment~"^router:"]');
  } catch (e) { /* none present */ }
  try {
    await mt.exec('/ip firewall nat remove [find comment~"^defconf"]');
    console.log('✓ Removed default-config NAT rules (this role owns NAT now)');
  } catch (e) { /* none present */ }

  await execWithWarning(
    mt,
    `/ip firewall nat add chain=srcnat action=masquerade out-interface-list=${WAN_LIST} ` +
      'comment="router:masquerade"',
    `Masquerade on every interface in the ${WAN_LIST} list`,
    'Could not add masquerade rule'
  );
}

/**
 * Build the input and forward chains.
 *
 * Order is deliberate. Everything that accepts management traffic is added
 * before the rule that drops it, so no partially applied state can lock the
 * device out. The drop rule is added last, and only after the LAN list has
 * been verified to contain the bridge.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {boolean} lanListVerified - Whether the LAN list contains the bridge
 * @param {boolean} fasttrack - Whether to enable fasttrack forwarding
 */
async function configureRouterFirewall(mt, lanListVerified, fasttrack) {
  console.log('\n=== Configuring Firewall ===');

  try {
    await mt.exec('/ip firewall filter remove [find comment~"^router:"]');
  } catch (e) { /* none present */ }
  try {
    await mt.exec('/ip firewall filter remove [find comment~"^defconf"]');
    console.log('✓ Removed default-config filter rules (this role owns the firewall now)');
  } catch (e) { /* none present */ }

  const rules = [
    ['chain=input action=accept connection-state=established,related,untracked',
      'router:input-established'],
    ['chain=input action=drop connection-state=invalid',
      'router:input-invalid'],
    ['chain=input action=accept protocol=icmp',
      'router:input-icmp'],
    [`chain=input action=accept in-interface-list=${LAN_LIST}`,
      'router:input-lan']
  ];

  for (const [rule, comment] of rules) {
    await execWithWarning(
      mt,
      `/ip firewall filter add ${rule} comment="${comment}"`,
      comment,
      `Could not add ${comment}`
    );
  }

  // Adding the drop rule is the one irreversible step here. Confirm the accept
  // rule that keeps management reachable actually landed - execWithWarning only
  // logs failures, so "we asked for it" is not evidence that it exists.
  let lanAcceptPresent = false;
  try {
    const check = await mt.exec('/ip firewall filter print terse where comment="router:input-lan"');
    lanAcceptPresent = Boolean(check && check.includes('router:input-lan'));
  } catch (e) {
    console.log(`⚠️  Could not verify the management accept rule: ${e.message}`);
  }

  if (lanListVerified && !lanAcceptPresent) {
    console.log('⚠️  The management accept rule is missing, so the WAN drop rule will be skipped.');
    console.log('    The router is left open on its uplinks rather than unreachable. Re-apply to fix.');
  }

  // Management is now explicitly accepted, so dropping the rest is safe.
  if (lanListVerified && lanAcceptPresent) {
    await execWithWarning(
      mt,
      `/ip firewall filter add chain=input action=drop in-interface-list=!${LAN_LIST} ` +
        'comment="router:input-drop-wan"',
      'router:input-drop-wan (management reachable from LAN only)',
      'Could not add input drop rule'
    );
  } else {
    console.log('⚠️  Skipped the input drop rule - LAN list could not be verified');
    console.log('    The router is left open on its uplinks. Fix the LAN list and re-apply.');
  }

  if (fasttrack) {
    await execWithWarning(
      mt,
      '/ip firewall filter add chain=forward action=fasttrack-connection hw-offload=yes ' +
        'connection-state=established,related comment="router:forward-fasttrack"',
      'router:forward-fasttrack',
      'Could not add fasttrack rule'
    );
  } else {
    console.log('ℹ️  Fasttrack off. Fasttracked flows skip connection tracking, which');
    console.log('   slows down how quickly stale sessions clear after a failover.');
  }

  const forwardRules = [
    ['chain=forward action=accept connection-state=established,related,untracked',
      'router:forward-established'],
    ['chain=forward action=drop connection-state=invalid',
      'router:forward-invalid'],
    [`chain=forward action=drop connection-state=new connection-nat-state=!dstnat in-interface-list=${WAN_LIST}`,
      'router:forward-drop-wan']
  ];

  for (const [rule, comment] of forwardRules) {
    await execWithWarning(
      mt,
      `/ip firewall filter add ${rule} comment="${comment}"`,
      comment,
      `Could not add ${comment}`
    );
  }
}

/**
 * Serve DHCP to the LAN.
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} lan - LAN configuration block
 */
async function configureDhcpServer(mt, lan) {
  const dhcp = lan.dhcpServer;
  if (!dhcp) {
    console.log('\nℹ️  No lan.dhcpServer block, DHCP server not configured');
    return;
  }

  console.log('\n=== Configuring DHCP Server ===');

  // Validation should have caught this, but configureRouter can be called
  // directly as a library function, and crashing here would abort an apply
  // that has already rewritten NAT, the firewall and the routes.
  const parsedLan = parseCidr(lan.address);
  if (!parsedLan) {
    console.log(`⚠️  lan.address ${lan.address ? `'${lan.address}' is not valid CIDR` : 'is missing'}, skipping DHCP server`);
    return;
  }

  const network = networkOf(lan.address);
  const gateway = parsedLan.address;
  const ranges = dhcp.pool || defaultPoolFor(lan.address);
  const leaseTime = dhcp.leaseTime || '12h';
  const dnsServers = (dhcp.dns && dhcp.dns.length) ? dhcp.dns.join(',') : gateway;

  if (!ranges) {
    console.log('⚠️  Could not determine a DHCP pool, skipping DHCP server');
    return;
  }

  // The default config ships its own server and pool on the same bridge.
  // Two servers on one interface is undefined behaviour, so remove those.
  for (const cmd of [
    '/ip dhcp-server remove [find comment~"^defconf"]',
    '/ip dhcp-server remove [find name="defconf"]',
    '/ip dhcp-server network remove [find comment~"^defconf"]',
    '/ip pool remove [find name="default-dhcp"]'
  ]) {
    try { await mt.exec(cmd); } catch (e) { /* not present */ }
  }

  // Update in place rather than remove and re-add. Removing a DHCP server
  // discards its lease table, so a second apply would drop every lease the
  // router had handed out.
  const upsert = async (findCmd, addCmd, setCmd, label) => {
    let exists = false;
    try {
      const found = await mt.exec(findCmd);
      exists = Boolean(found && found.trim());
    } catch (e) { /* treat as absent */ }

    await execWithWarning(mt, exists ? setCmd : addCmd, `${label}${exists ? ' (updated)' : ''}`, `Could not configure ${label}`);
  };

  await upsert(
    `/ip pool print terse where name=${q(LAN_POOL)}`,
    `/ip pool add name=${LAN_POOL} ranges=${ipRange(ranges, 'lan.dhcpServer.pool')}`,
    `/ip pool set [find name=${q(LAN_POOL)}] ranges=${ipRange(ranges, 'lan.dhcpServer.pool')}`,
    `Pool ${LAN_POOL}: ${ranges}`
  );

  await upsert(
    `/ip dhcp-server print terse where name=${q(LAN_DHCP)}`,
    `/ip dhcp-server add name=${LAN_DHCP} interface=bridge address-pool=${LAN_POOL} ` +
      `lease-time=${duration(leaseTime, 'lan.dhcpServer.leaseTime')} disabled=no comment="router:lan"`,
    `/ip dhcp-server set [find name=${q(LAN_DHCP)}] interface=bridge address-pool=${LAN_POOL} ` +
      `lease-time=${duration(leaseTime, 'lan.dhcpServer.leaseTime')} disabled=no comment="router:lan"`,
    `DHCP server ${LAN_DHCP} on bridge (lease ${leaseTime})`
  );

  await upsert(
    `/ip dhcp-server network print terse where comment="router:lan"`,
    `/ip dhcp-server network add address=${cidr(network, 'LAN network')} gateway=${ipv4(gateway, 'LAN gateway')} ` +
      `dns-server=${ipv4List(dnsServers, 'DHCP dns-server')} comment="router:lan"`,
    `/ip dhcp-server network set [find comment="router:lan"] address=${cidr(network, 'LAN network')} ` +
      `gateway=${ipv4(gateway, 'LAN gateway')} dns-server=${ipv4List(dnsServers, 'DHCP dns-server')}`,
    `DHCP network ${network} (gateway ${gateway}, DNS ${dnsServers})`
  );
}

/**
 * Point the router at fixed resolvers.
 *
 * This matters more than it looks. If the router keeps the resolvers its ISP
 * handed out, then after a failover it still points at servers it can no
 * longer reach. Routing works, every lookup times out, and it reads as a
 * failed failover.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} lan - LAN configuration block
 */
async function configureDns(mt, lan) {
  const dns = lan.dns;
  if (!dns || !dns.servers || dns.servers.length === 0) {
    console.log('\nℹ️  No lan.dns.servers block, DNS left unchanged');
    return;
  }

  console.log('\n=== Configuring DNS ===');

  const allowRemote = dns.allowRemoteRequests === false ? 'no' : 'yes';
  await execWithWarning(
    mt,
    `/ip dns set servers=${ipv4List(dns.servers, 'lan.dns.servers')} allow-remote-requests=${allowRemote}`,
    `Resolvers ${dns.servers.join(', ')} (allow-remote-requests=${allowRemote})`,
    'Could not configure DNS'
  );
}

/**
 * Put the configured LAN address on the bridge.
 *
 * Adding is safe on its own, so it happens early: the DHCP server and its
 * network entry need this address to exist before they mean anything. The old
 * address stays for now. Removing it is the risky half, and that is deferred
 * to removeStaleLanAddresses() at the very end.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} lan - LAN configuration block
 * @returns {boolean} - True when the address is present
 */
async function addLanAddress(mt, lan) {
  console.log('\n=== Adding LAN Address ===');

  const desired = lan.address;

  try {
    const existing = await mt.exec('/ip address print terse where interface=bridge');
    // Match the whole address token. A host-part substring would treat a
    // changed prefix length as "already present", and would also match
    // 10.0.0.1/24 inside 110.0.0.1/24.
    const present = [...existing.matchAll(/address=(\d+\.\d+\.\d+\.\d+\/\d+)/g)].map(m => m[1]);
    if (present.includes(desired)) {
      console.log(`✓ ${desired} already on bridge`);
      return true;
    }
    await mt.exec(`/ip address add address=${cidr(desired, 'lan.address')} interface=bridge comment="router:lan"`);
    console.log(`✓ Added ${desired} to bridge`);
    return true;
  } catch (e) {
    if (e.message.includes('already have')) {
      console.log(`✓ ${desired} already on bridge`);
      return true;
    }
    console.log(`✗ Could not add ${desired}: ${e.message}`);
    return false;
  }
}

/**
 * Drop bridge addresses that are not the configured one.
 *
 * This runs last, and it refuses to remove the address carrying the current
 * session. So the first run leaves both addresses in place and stays
 * reachable; a second run, made over the new address, clears the old one.
 * There is never a moment when the device has no reachable address.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} lan - LAN configuration block
 * @param {string} connectedHost - Address this session connected to
 * @returns {boolean} - True when a stale address is still waiting for removal
 */
async function removeStaleLanAddresses(mt, lan, connectedHost) {
  console.log('\n=== Removing Stale LAN Addresses ===');

  const desired = lan.address;
  let pending = false;

  // connectedHost may be an FQDN, which no address comparison would match.
  const sessionIp = await resolveHostAddress(connectedHost);
  if (connectedHost && !sessionIp) {
    console.log('⚠️  Cannot tell which address carries this session, so none will be removed.');
    console.log(`    Remove the old address by hand once you can reach ${desired.split('/')[0]}.`);
    return true;
  }

  // Never delete anything until the replacement is provably in place. If the
  // add failed and we deleted anyway, the device would be left with no address
  // on the LAN at all.
  try {
    const check = await mt.exec('/ip address print terse where interface=bridge');
    const present = [...check.matchAll(/address=(\d+\.\d+\.\d+\.\d+\/\d+)/g)].map(m => m[1]);
    if (!present.includes(desired)) {
      console.log(`✗ ${desired} is not on the bridge, so nothing will be removed.`);
      console.log('    Fix the LAN address first, then apply again.');
      return true;
    }
  } catch (e) {
    console.log(`⚠️  Could not confirm ${desired} is present: ${e.message}. Removing nothing.`);
    return true;
  }

  try {
    const detail = await mt.exec('/ip address print detail without-paging where interface=bridge');

    for (const record of splitDetailRecords(detail)) {
      const addrMatch = record.match(/address=(\d+\.\d+\.\d+\.\d+\/\d+)/);
      if (!addrMatch) continue;
      const addr = addrMatch[1];
      if (addr === desired) continue;

      // Only addresses this tool owns, plus the factory address it replaces,
      // are ours to delete. A hand-added secondary or recovery address on the
      // bridge must survive - the comment-ownership model says so everywhere
      // else, and this used to be the one place that ignored it.
      const comment = recordComment(record);
      const owned = comment === 'router:lan' || (comment || '').startsWith('defconf');
      if (!owned) {
        console.log(`ℹ️  Leaving ${addr} alone - not managed by this tool${comment ? ` (comment: ${comment})` : ''}`);
        continue;
      }

      if (sessionIp && cidrContains(sessionIp, addr)) {
        pending = true;
        console.log(`ℹ️  Keeping ${addr} - this session is connected through it`);
        console.log(`    Reconnect at ${desired.split('/')[0]} and apply again to remove it.`);
        continue;
      }

      try {
        await mt.exec(`/ip address remove [find address=${q(addr)} interface=bridge]`);
        console.log(`✓ Removed stale address ${addr}`);
      } catch (e) {
        console.log(`⚠️  Could not remove ${addr}: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`⚠️  Could not audit bridge addresses: ${e.message}`);
  }

  return pending;
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

/**
 * Split RouterOS "print detail" output into one string per record.
 * Records begin with an index number; continuation lines are indented.
 * @param {string} output
 * @returns {Array<string>}
 */
function splitDetailRecords(output) {
  if (!output) return [];
  // Records start at the left margin with their index; continuation lines are
  // indented far more. A looser split breaks on wrapped numeric lists, whose
  // final line can look exactly like the start of a new record.
  const chunks = output.split(/\r?\n(?=\s{0,3}\d+\s)/);

  // The first chunk is usually a "Flags: ..." header, but RouterOS omits it
  // for object types that have no flags (`/ip pool print detail` is one), and
  // then record 0 leads. Dropping it blindly loses that record.
  if (chunks.length && !/^\s{0,3}\d+\s/.test(chunks[0])) {
    return chunks.slice(1);
  }
  return chunks;
}

/**
 * Read the ";;; comment" RouterOS prints above each record.
 * Detail output does not render comments as comment="..." the way terse does,
 * which is easy to get wrong.
 * @param {string} record
 * @returns {string|null}
 */
function recordComment(record) {
  const match = record.match(/;;;\s*([^\r\n]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Read a router configuration back off a device.
 *
 * The comments written during apply are what make this possible. Without them
 * there is no way to tell a route this tool owns from one a person added by
 * hand. lib/access-list.js reads its rules back the same way.
 *
 * The role is detected from the masquerade rule rather than from the routes.
 * Routes only exist while an uplink is up, so a router whose links are all
 * down would otherwise read back as "not a router" and lose its whole config.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @returns {Promise<Object|null>} - {lan, wan} or null if this is not a router
 */
async function backupRouterConfig(mt) {
  try {
    const nat = await mt.exec('/ip firewall nat print terse where comment="router:masquerade"');
    if (!nat || !nat.includes('router:masquerade')) return null;
  } catch (e) {
    return null;
  }

  console.log('\n=== Reading Router Configuration ===');

  const links = new Map();
  const linkFor = (name) => {
    if (!links.has(name)) links.set(name, { name });
    return links.get(name);
  };

  // The WAN list members are the authoritative record. They exist whether or
  // not the link is currently up.
  try {
    const memberOut = await mt.exec(
      `/interface list member print detail without-paging where list=${WAN_LIST}`
    );
    for (const record of splitDetailRecords(memberOut)) {
      const parsed = parseWanMemberComment(recordComment(record));
      if (!parsed) continue;
      const iface = record.match(/interface=(\S+)/);
      Object.assign(linkFor(parsed.name), parsed, iface ? { interface: iface[1] } : {});
    }
  } catch (e) {
    console.log(`⚠️  Could not read ${WAN_LIST} list members: ${e.message}`);
  }

  // Routes confirm the probe target and failover order for links that are up.
  try {
    const routeOut = await mt.exec('/ip route print detail without-paging where comment~"^wan:"');
    for (const record of splitDetailRecords(routeOut)) {
      const comment = recordComment(record);
      const match = comment && comment.match(/^wan:(\S+)\s+(probe|default)$/);
      if (!match) continue;
      const link = linkFor(match[1]);

      if (match[2] === 'probe') {
        const dst = record.match(/dst-address=(\d+\.\d+\.\d+\.\d+)\/32/);
        if (dst && !link.probe) link.probe = dst[1];
        const gw = record.match(/gateway=(\S+)/);
        if (gw && !link.gateway) link.gateway = gw[1];
      } else {
        const dist = record.match(/distance=(\d+)/);
        if (dist && link.distance === undefined) link.distance = parseInt(dist[1], 10);
      }
    }
  } catch (e) {
    console.log(`⚠️  Could not read routes: ${e.message}`);
  }

  // Each uplink type leaves its own object behind, and that object is what
  // survives when the link is down. Reading these too means an unplugged WAN
  // still round-trips instead of quietly disappearing from the backup.
  const sources = [
    { cmd: '/ip dhcp-client print detail without-paging', type: 'dhcp' },
    { cmd: '/interface pppoe-client print detail without-paging', type: 'pppoe' },
    { cmd: '/ip address print detail without-paging', type: 'static' }
  ];

  for (const { cmd, type } of sources) {
    let out;
    try { out = await mt.exec(cmd); } catch (e) { continue; }

    for (const record of splitDetailRecords(out)) {
      const comment = recordComment(record);
      const match = comment && comment.match(/^wan:(\S+)$/);
      if (!match) continue;

      const link = linkFor(match[1]);
      if (link.type && link.interface) continue;
      if (!link.type) link.type = type;

      const iface = record.match(/interface=(\S+)/);
      if (iface && !link.interface) link.interface = iface[1];
      if (type === 'pppoe') {
        if (!link.user) {
          const user = record.match(/user="([^"]*)"|user=(\S+)/);
          if (user) link.user = user[1] !== undefined ? user[1] : user[2];
        }
        // Without this the backup applies with an empty password and knocks
        // the uplink offline.
        const pass = record.match(/password="([^"]*)"|password=(\S+)/);
        if (pass) link.password = pass[1] !== undefined ? pass[1] : pass[2];
      }
      if (type === 'static') {
        const addr = record.match(/address=(\d+\.\d+\.\d+\.\d+\/\d+)/);
        if (addr) link.address = addr[1];
        const gw = record.match(/gateway=(\S+)/);
        if (gw) link.gateway = gw[1];
      }
    }
  }

  // Whatever is left is a point-to-point link, where the probe route's gateway
  // is the interface itself. LTE is the usual case.
  let lteDetail = '';
  try { lteDetail = await mt.exec('/interface lte print detail without-paging'); } catch (e) { /* no modem */ }

  for (const link of links.values()) {
    if (link.type || !link.gateway) continue;

    if (lteDetail.includes(`name="${link.gateway}"`)) {
      link.type = 'lte';
      link.interface = link.gateway;

      // Recover the APN from the profile this interface uses. An APN left to
      // the network is recorded as absent, matching how it is configured.
      const profile = lteDetail.match(
        new RegExp(`name="${link.gateway}"[\\s\\S]*?apn-profiles=(\\S+)`)
      );
      if (profile) {
        try {
          const apnOut = await mt.exec(
            `/interface lte apn print detail without-paging where name="${profile[1].replace(/"/g, '')}"`
          );
          const apn = apnOut.match(/apn="([^"]*)"/);
          if (apn && apn[1] && !/use-network-apn=yes/.test(apnOut)) link.apn = apn[1];
        } catch (e) { /* profile gone */ }
      }
    } else {
      link.type = 'static';
      link.interface = link.gateway;
    }
  }

  const wan = [...links.values()]
    .sort((a, b) => (a.distance === undefined ? 99 : a.distance) - (b.distance === undefined ? 99 : b.distance))
    .map(link => {
      const entry = { name: link.name, interface: link.interface, type: link.type };
      if (link.distance !== undefined) entry.distance = link.distance;
      if (link.probe) entry.probe = link.probe;
      if (link.apn) entry.apn = link.apn;
      if (link.address) entry.address = link.address;
      if (link.type === 'static' && link.gateway) entry.gateway = link.gateway;
      if (link.user) entry.user = link.user;
      if (link.password) entry.password = link.password;
      if (link.type === 'pppoe' && !link.password) {
        console.log(`⚠️  ${link.name}: could not read the PPPoE password off the device.`);
        console.log('    Add it to the backed-up config before applying, or the uplink will be reset with an empty password.');
      }
      return entry;
    });

  for (const link of wan) {
    const dist = link.distance !== undefined ? link.distance : 'unset';
    const probe = link.probe || 'unset (link was down)';
    console.log(`✓ Uplink ${link.name}: ${link.interface} (${link.type}), distance ${dist}, probe ${probe}`);
  }

  const lan = {};

  // LAN address: prefer the one this tool wrote, else any static bridge address.
  try {
    const addrOut = await mt.exec('/ip address print detail without-paging where interface=bridge');
    const records = splitDetailRecords(addrOut);
    const owned = records.find(r => recordComment(r) === 'router:lan');
    const pick = owned || records.find(r => !/^\s*\d+\s+\S*D/.test(r));
    const match = (pick || '').match(/address=(\d+\.\d+\.\d+\.\d+\/\d+)/);
    if (match) {
      lan.address = match[1];
      console.log(`✓ LAN address: ${lan.address}`);
    }
  } catch (e) {
    console.log(`⚠️  Could not read LAN address: ${e.message}`);
  }

  // LAN ports: bridge members that are not uplinks.
  try {
    const wanIfaces = new Set(wan.map(w => w.interface));
    const portsOut = await mt.exec('/interface bridge port print detail without-paging');
    // Not every LAN port is an ether*. sfp, sfp-sfpplus and bond interfaces
    // are all valid bridge members and were previously dropped from backups.
    //
    // RouterOS prints an internal id such as `*2` for a port whose interface
    // no longer resolves to a name. Those are not usable in a config: writing
    // one back would produce `interface=*2` on the next apply.
    const ports = [...portsOut.matchAll(/interface=(\S+)/g)]
      .map(m => m[1].replace(/^"|"$/g, ''))
      .filter(name =>
        IDENTIFIER.test(name) &&
        !wanIfaces.has(name) &&
        name !== 'bridge' &&
        !/^wifi|^wlan/.test(name));
    lan.ports = [...new Set(ports)];
    if (lan.ports.length) console.log(`✓ LAN ports: ${lan.ports.join(', ')}`);
  } catch (e) {
    console.log(`⚠️  Could not read bridge ports: ${e.message}`);
  }

  // DHCP server and its pool.
  try {
    const srv = await mt.exec('/ip dhcp-server print detail without-paging where comment="router:lan"');
    if (srv && srv.includes('name=')) {
      const dhcpServer = {};
      const lease = srv.match(/lease-time=(\S+)/);
      if (lease) dhcpServer.leaseTime = lease[1];

      // dns-server on the network entry is what clients are told to use. It is
      // configurable, so it has to round-trip. Only record it when it differs
      // from the gateway, which is the default this tool writes.
      try {
        const net = await mt.exec('/ip dhcp-server network print detail without-paging where comment="router:lan"');
        const dnsServer = net.match(/dns-server=(\S+)/);
        const gw = net.match(/gateway=(\S+)/);
        if (dnsServer && gw && dnsServer[1] !== gw[1]) {
          dhcpServer.dns = dnsServer[1].split(',').filter(Boolean);
        }
      } catch (e) { /* network entry absent */ }

      const pool = srv.match(/address-pool=(\S+)/);
      if (pool) {
        const poolOut = await mt.exec(`/ip pool print detail without-paging where name=${pool[1]}`);
        const ranges = poolOut.match(/ranges=(\S+)/);
        if (ranges) dhcpServer.pool = ranges[1];
      }

      if (Object.keys(dhcpServer).length) {
        lan.dhcpServer = dhcpServer;
        console.log(`✓ DHCP server: ${dhcpServer.pool || 'pool unknown'} (lease ${dhcpServer.leaseTime})`);
      }
    }
  } catch (e) {
    console.log(`⚠️  Could not read DHCP server: ${e.message}`);
  }

  // Resolvers.
  try {
    const dnsOut = await mt.exec('/ip dns print');
    // RouterOS wraps a multi-server list onto unlabelled continuation lines,
    // so collect lines until the next "label:" appears.
    const lines = dnsOut.split(/\r?\n/);
    const startIndex = lines.findIndex(l => /^\s*servers:/.test(l));
    const collected = [];
    if (startIndex !== -1) {
      collected.push(lines[startIndex].replace(/^\s*servers:/, ''));
      for (let i = startIndex + 1; i < lines.length; i++) {
        if (/^\s*[\w-]+:/.test(lines[i])) break;
        collected.push(lines[i]);
      }
    }
    const list = collected.join(',').split(/[,\s]+/).filter(Boolean);
    if (list.length) {
      lan.dns = {
        servers: list,
        allowRemoteRequests: /allow-remote-requests:\s*yes/.test(dnsOut)
      };
      console.log(`✓ Resolvers: ${list.join(', ')}`);
    }
  } catch (e) {
    console.log(`⚠️  Could not read DNS: ${e.message}`);
  }

  // Fasttrack is opt-in, so only record it when it is on.
  try {
    const ft = await mt.exec('/ip firewall filter print terse where comment="router:forward-fasttrack"');
    if (ft && ft.trim()) {
      lan.fasttrack = true;
      console.log('✓ Fasttrack enabled');
    }
  } catch (e) { /* absent */ }

  return { lan, wan };
}

/**
 * Configure the radios and SSIDs.
 *
 * A router owns an untagged LAN, so an SSID with no `vlan` joins the bridge
 * untagged. Give an SSID a `vlan` and it is tagged, the same as the AP roles.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} config - Device configuration
 */
async function configureRouterWifi(mt, config) {
  const ssids = config.ssids || [];
  if (ssids.length === 0) {
    console.log('\nℹ️  No SSIDs configured, radios left untouched');
    return;
  }

  console.log('\n=== Configuring WiFi ===');

  const wifiPackage = await detectWifiPackage(mt);
  if (!wifiPackage) {
    console.log('⚠️  No supported WiFi package, skipping WiFi');
    console.log('    This tool needs wifi-qcom. Devices on the legacy `wireless`');
    console.log('    package expose /interface wireless instead, which is not supported.');
    return;
  }

  const wifiPath = getWifiPath(wifiPackage);
  const wifiConfig = config.wifi || {};
  const country = wifiConfig.country || 'United States';
  const { interface24, interface5 } = await detectRadioLayout(mt);
  const bandToInterface = { '2.4GHz': interface24, '5GHz': interface5 };

  // Start from a known state so the device matches the config exactly.
  try {
    await mt.exec(`${wifiPath}/datapath remove [find name~"wifi"]`);
  } catch (e) { /* none present */ }
  try {
    await mt.exec(`${wifiPath} remove [find master-interface]`);
  } catch (e) { /* none present */ }
  for (const name of ['wifi1', 'wifi2']) {
    try {
      await mt.exec(`${wifiPath} set [find default-name=${name}] name=${name}`);
    } catch (e) { /* single-band device */ }
  }
  console.log('✓ Cleared previous virtual interfaces and datapaths');

  // Band settings, using whichever band token this radio actually supports.
  for (const band of ['2.4GHz', '5GHz']) {
    const bandConfig = wifiConfig[band];
    if (!bandConfig) continue;

    const iface = bandToInterface[band];
    const freqMap = band === '2.4GHz' ? CHANNEL_FREQ_24GHZ : CHANNEL_FREQ_5GHZ;
    const commands = [`channel.band=${await detectBandToken(mt, wifiPath, iface, band)}`];

    if (bandConfig.channel !== undefined && freqMap[bandConfig.channel]) {
      commands.push(`channel.frequency=${freqMap[bandConfig.channel]}`);
    } else if (bandConfig.frequency !== undefined) {
      commands.push(`channel.frequency=${integer(bandConfig.frequency, `${band} frequency`)}`);
    }
    if (bandConfig.width !== undefined) {
      commands.push(`channel.width=${must(bandConfig.width, /^[0-9a-zA-Z/+-]{1,32}$/, `${band} width`)}`);
    }
    if (bandConfig.txPower !== undefined) {
      commands.push(`configuration.tx-power=${integer(bandConfig.txPower, `${band} txPower`)}`);
    }
    commands.push(`configuration.country=${q(bandConfig.country || country)}`);

    await execWithWarning(
      mt,
      `${wifiPath} set ${iface} ${commands.join(' ')}`,
      `${band} band settings on ${iface}`,
      `Could not apply ${band} settings`
    );
  }

  // One master interface per band; extra SSIDs get virtual interfaces.
  const bandUsage = { '2.4GHz': 0, '5GHz': 0 };

  for (const ssidConfig of ssids) {
    const { ssid, passphrase, vlan, bands } = ssidConfig;
    if (!ssid || !passphrase || !bands || bands.length === 0) {
      console.log(`⚠️  Skipping incomplete SSID: ${ssid || 'unnamed'}`);
      continue;
    }

    for (const band of bands) {
      const master = bandToInterface[band];
      if (!master) {
        console.log(`  ⚠️  Unknown band ${band}, skipping`);
        continue;
      }

      const isVirtual = bandUsage[band] > 0;
      const iface = isVirtual ? `${master}-ssid${bandUsage[band] + 1}` : master;
      bandUsage[band]++;

      try {
        if (isVirtual) {
          try {
            await mt.exec(`${wifiPath} add master-interface=${ifaceName(master)} name=${q(iface)}`);
            console.log(`  ✓ Created virtual interface ${iface}`);
            await new Promise(r => setTimeout(r, 500));
          } catch (e) {
            if (!/already have|exists/.test(e.message)) throw e;
          }
        }

        // No named datapath object is created. configureWifiInterface writes
        // the bridge and vlan inline on the interface, so a separate object
        // would never be referenced by anything.
        await configureWifiInterface(mt, wifiPath, iface, ssidConfig, country, wifiConfig[band] || {});
      } catch (e) {
        console.log(`  ✗ Failed to configure ${iface}: ${e.message}`);
      }
    }
  }

  // A radio with no SSIDs should be off, not broadcasting a stale default.
  for (const [band, count] of Object.entries(bandUsage)) {
    if (count > 0) continue;
    await execWithWarning(
      mt,
      `${wifiPath} set ${bandToInterface[band]} disabled=yes`,
      `Disabled ${bandToInterface[band]} (${band}) - no SSIDs configured`,
      `Could not disable ${bandToInterface[band]}`
    );
  }
}

/**
 * Confirm the things a router cannot work without actually exist.
 *
 * Most phases log a warning and continue, which is right for optional features
 * but means an apply could previously report success with no default route, no
 * NAT and no DHCP. Fleet automation had no way to tell a healthy router from a
 * broken one.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} lan - LAN configuration block
 * @returns {Promise<string[]>} - Problems found, empty when healthy
 */
async function verifyRouterState(mt, lan) {
  console.log('\n=== Verifying ===');
  const problems = [];

  const check = async (label, command, expect) => {
    try {
      const out = await mt.exec(command);
      if (expect(out)) {
        console.log(`✓ ${label}`);
      } else {
        console.log(`✗ ${label}`);
        problems.push(label);
      }
    } catch (e) {
      console.log(`✗ ${label} (${e.message})`);
      problems.push(`${label}: ${e.message}`);
    }
  };

  if (lan.address) {
    await check(
      `LAN address ${lan.address} is on the bridge`,
      '/ip address print terse where interface=bridge',
      out => out.includes(`address=${lan.address}`)
    );
  }

  await check(
    'at least one managed default route exists',
    '/ip route print terse where dst-address=0.0.0.0/0',
    out => /comment=wan:/.test(out)
  );

  await check(
    'masquerade rule is present',
    '/ip firewall nat print terse where comment="router:masquerade"',
    out => out.includes('router:masquerade')
  );

  await check(
    'management is accepted from the LAN',
    '/ip firewall filter print terse where comment="router:input-lan"',
    out => out.includes('router:input-lan')
  );

  if (lan.dhcpServer) {
    await check(
      'DHCP server is running on the bridge',
      `/ip dhcp-server print terse where name=${q(LAN_DHCP)}`,
      out => out.includes(LAN_DHCP) && !out.includes('disabled=yes')
    );
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Configure a device as a multi-WAN router.
 * @param {Object} config - Device configuration with lan and wan blocks
 * @returns {Promise<boolean>} Success status
 */
async function configureRouter(config = {}) {
  const mt = new MikroTikSSH(
    config.host || '192.168.88.1',
    config.username || 'admin',
    config.password || 'admin'
  );

  const lan = config.lan || {};
  const wans = normalizeWans(config.wan || []);

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('MikroTik Router Configuration');
    console.log('Multi-WAN with failover');
    console.log('========================================');
    console.log(`\nLAN: ${lan.address || 'unset'}`);
    console.log('Uplinks, best first:');
    for (const wan of wans) {
      console.log(`  ${wan.distance}. ${wan.name} - ${wan.interface} (${wan.type}), probe ${wan.probe}`);
    }

    await setDeviceIdentity(mt, config);
    await ensureBridgeInfrastructure(mt);
    await configureIgmpSnooping(mt, config.igmpSnooping || false);

    const lanListVerified = await configureInterfaceLists(mt, wans);
    await configureLanBridge(mt, lan, wans);
    await configureWanLinks(mt, wans);

    // Give DHCP and LTE links a moment to obtain an address before their
    // gateways are read back for the probe routes.
    console.log('\n⏳ Waiting 10s for uplinks to obtain addresses...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    await configureFailoverRoutes(mt, wans);
    await configureNat(mt);
    await configureRouterFirewall(mt, lanListVerified, lan.fasttrack === true);

    // The DHCP server and its network entry only make sense once the bridge
    // actually holds the LAN address, so add it before they are created.
    let lanAddressReady = true;
    if (lan.address) {
      lanAddressReady = await addLanAddress(mt, lan);
    }
    await configureDhcpServer(mt, lan);
    await configureDns(mt, lan);
    await configureRouterWifi(mt, config);
    await configureSyslog(mt, config);

    let pending = false;
    if (lan.address && lanAddressReady) {
      pending = await removeStaleLanAddresses(mt, lan, config.host);
    } else if (lan.address) {
      pending = true;
      console.log('\n⚠️  Skipping stale-address cleanup because the LAN address was not added.');
    }

    const problems = await verifyRouterState(mt, lan);
    if (problems.length > 0) {
      console.log('\n========================================');
      console.log('✗ Router Configuration INCOMPLETE');
      console.log('========================================');
      problems.forEach(p => console.log(`  - ${p}`));
      await mt.close();
      throw new Error(`Router configuration finished with ${problems.length} unmet requirement(s): ${problems.join('; ')}`);
    }

    console.log('\n========================================');
    console.log('✓✓✓ Router Configuration Complete! ✓✓✓');
    console.log('========================================');

    if (pending) {
      console.log('\nOne step remains.');
      console.log(`Reconnect at ${lan.address.split('/')[0]} and apply again.`);
      console.log('That run removes the old address and verifies the rest.');
    }

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ Router Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

module.exports = {
  configureRouter,
  // exported for reuse and for tests
  normalizeWans,
  parseCidr,
  cidrContains,
  networkOf,
  defaultPoolFor,
  resolveWanGateway,
  addLanAddress,
  removeStaleLanAddresses,
  backupRouterConfig,
  configureRouterWifi,
  resolveHostAddress,
  verifyRouterState,
  wanMemberComment,
  parseWanMemberComment
};
