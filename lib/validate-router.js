/**
 * Router role configuration validation
 *
 * Lives in its own module because both entry points need it: apply-config.js
 * for a single device and apply-multiple-devices.js for a fleet. It used to
 * exist only in apply-config.js, which meant a router inside a multi-device
 * deployment was applied with no validation at all.
 */

const { CIDR, IPV4, IP_RANGE, DURATION, IDENTIFIER, HTTP_URL, NOTIFY_TITLE } = require('./routeros-args');
const { normalizeWans, managementAllowList } = require('./router');

const VALID_WAN_TYPES = ['dhcp', 'static', 'pppoe', 'lte'];
// Shape alone is not enough: 999.999.999.999/99 matched the old pattern.
const CIDR_RE = CIDR;

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/**
 * Convert a RouterOS duration such as "30s" or "5m" to seconds.
 * A bare number is seconds, which is how RouterOS reads it.
 * @param {string} value
 * @returns {number}
 */
function durationSeconds(value) {
  const match = String(value).match(/^(\d+)([smhdw]?)$/);
  if (!match) return NaN;
  return parseInt(match[1], 10) * (DURATION_UNITS[match[2]] || 1);
}

/**
 * Validate the optional `notify` block.
 *
 * Everything here ends up either in a device command or in the body of a
 * generated RouterOS script, so the shapes are strict on purpose.
 *
 * @param {Object} notify - The notify block
 * @param {string} label - Prefix for messages
 * @param {string[]} errors - Collected errors, appended to
 * @param {string[]} warnings - Collected warnings, appended to
 */
function validateNotify(notify, label, errors, warnings) {
  if (typeof notify !== 'object' || Array.isArray(notify)) {
    errors.push(`${label}: notify must be a mapping with at least a url`);
    return;
  }

  if (!notify.url) {
    errors.push(`${label}: notify.url is required (e.g. https://ntfy.sh/your-topic)`);
  } else if (!HTTP_URL.test(String(notify.url))) {
    errors.push(`${label}: notify.url '${notify.url}' must be an http:// or https:// URL with no spaces or quotes`);
  } else if (/^http:\/\//.test(String(notify.url))) {
    // For ntfy and most webhook services the URL itself is the credential.
    warnings.push(
      `${label}: notify.url is plain http, so the URL - which is usually the only secret ` +
      'protecting the topic - crosses the internet in clear text. Prefer https.'
    );
  }

  if (notify.title !== undefined && !NOTIFY_TITLE.test(String(notify.title))) {
    errors.push(`${label}: notify.title '${notify.title}' must be 1-64 characters with no comma, quote or newline`);
  }

  if (notify.interval !== undefined) {
    if (!DURATION.test(String(notify.interval))) {
      errors.push(`${label}: notify.interval '${notify.interval}' must look like 30s, 5m or 1h`);
    } else if (/^0+[smhdw]?$/.test(String(notify.interval))) {
      errors.push(`${label}: notify.interval cannot be zero - the scheduler would never run`);
    } else if (durationSeconds(notify.interval) < 10) {
      // Measured on a Chateau LTE6: a POST to an unreachable endpoint took
      // about 10 seconds to give up, and the tick blocks for that whole time.
      warnings.push(
        `${label}: notify.interval of ${notify.interval} is shorter than the time /tool fetch takes ` +
        'to give up on an unreachable endpoint (~10s), so ticks would pile up during an outage.'
      );
    }
  }

  if (notify.checkCertificate !== undefined && typeof notify.checkCertificate !== 'boolean') {
    errors.push(`${label}: notify.checkCertificate must be true or false`);
  }

  // A factory device has no CA certificates at all and often lacks the flash to
  // import a bundle, so turning verification on is how you get a notifier that
  // silently never delivers.
  if (notify.checkCertificate === true) {
    warnings.push(
      `${label}: notify.checkCertificate is on, so /tool fetch verifies the TLS chain. ` +
      'A device with no imported CA certificates (`/certificate print count-only` = 0) will fail every send.'
    );
  }
}

/**
 * Validate the optional `lan.management` block.
 *
 * This block can only ever WIDEN which sources reach the management services,
 * so it is the one place a user config could undo the "no WAN admin access"
 * property. It cannot: every entry has to name non-globally-routable space,
 * which is checked here, and is checked again at apply time against the
 * addresses actually on the uplinks (a double-NAT WAN is RFC1918 too, so the
 * static check alone is not sufficient).
 *
 * @param {Object} management - The lan.management block
 * @param {Object} lan - The whole LAN block, for context
 * @param {string} label - Prefix for messages
 * @param {string[]} errors - Collected errors, appended to
 * @param {string[]} warnings - Collected warnings, appended to
 */
function validateManagement(management, lan, label, errors, warnings) {
  if (typeof management !== 'object' || management === null || Array.isArray(management)) {
    errors.push(`${label}: lan.management must be a mapping (allow, cleartext)`);
    return;
  }

  // Compared with `=== true`, so a stringy "true" from YAML would read as
  // "disable them" and silently do the opposite of what was written.
  if (management.cleartext !== undefined && typeof management.cleartext !== 'boolean') {
    errors.push(`${label}: lan.management.cleartext must be true or false`);
  }
  if (management.cleartext === true) {
    warnings.push(
      `${label}: lan.management.cleartext keeps telnet and ftp enabled. Both send the ` +
      'password in clear text. They stay bound to the LAN, so this is a LAN-sniffing risk, ' +
      'not a WAN one.'
    );
  }

  if (management.allow === undefined) return;
  if (!Array.isArray(management.allow)) {
    errors.push(`${label}: lan.management.allow must be a list of CIDR ranges`);
    return;
  }

  // managementAllowList() is what the apply actually uses, so validating its
  // output means the two can never disagree about which entries are acceptable.
  const { problems } = managementAllowList(lan);
  problems.forEach(problem => errors.push(`${label}: ${problem}`));

  if (management.allow.length > 0 && problems.length === 0) {
    warnings.push(
      `${label}: lan.management.allow widens management beyond the LAN to ` +
      `${management.allow.join(', ')}. Those ranges are private, so they cannot be an ` +
      'internet source, but anything that can reach them can reach the admin interfaces.'
    );
  }
}

/**
 * Validate the lan and wan blocks of a router-role configuration.
 *
 * Returns errors and warnings separately. The distinction matters: an error
 * means the apply would do something wrong or dangerous, while a warning means
 * the config works but has a sharp edge. Refusing to apply a working
 * production config over a sharp edge is worse than the edge.
 *
 * @param {Object} config - Device configuration
 * @param {string} label - Prefix for messages, e.g. "Device 2"
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateRouterConfig(config, label = 'Router') {
  const errors = [];
  const warnings = [];
  const lan = config.lan || {};
  const wans = config.wan || [];

  if (!lan.address) {
    errors.push(`${label}: missing lan.address (e.g. 192.168.80.1/24)`);
  } else if (!CIDR_RE.test(lan.address)) {
    errors.push(`${label}: lan.address '${lan.address}' is not valid CIDR (e.g. 192.168.80.1/24)`);
  }

  // A DHCP server needs a LAN address to derive its network and gateway from.
  if (lan.dhcpServer && (!lan.address || !CIDR_RE.test(lan.address))) {
    errors.push(`${label}: lan.dhcpServer needs a valid lan.address to derive its network from`);
  }

  if (config.notify !== undefined) {
    validateNotify(config.notify, label, errors, warnings);
  }

  if (lan.management !== undefined) {
    validateManagement(lan.management, lan, label, errors, warnings);
  }

  if (!Array.isArray(wans) || wans.length === 0) {
    errors.push(`${label}: wan must be a non-empty list of uplinks`);
    return { errors, warnings };
  }

  if (lan.ports !== undefined && !Array.isArray(lan.ports)) {
    errors.push(`${label}: lan.ports must be a list`);
  }
  // Guard the type explicitly. `mssClamp` defaults to on and is compared with
  // `!== false`, so a stringy "false" from YAML would read as ON and silently
  // do the opposite of what was written.
  if (lan.mssClamp !== undefined && typeof lan.mssClamp !== 'boolean') {
    errors.push(`${label}: lan.mssClamp must be true or false`);
  }
  if (lan.dns?.servers !== undefined && !Array.isArray(lan.dns.servers)) {
    errors.push(`${label}: lan.dns.servers must be a list`);
  }
  for (const port of Array.isArray(lan.ports) ? lan.ports : []) {
    if (!IDENTIFIER.test(String(port))) {
      errors.push(`${label}: lan.ports entry '${port}' is not a valid interface name`);
    }
  }
  for (const server of Array.isArray(lan.dns?.servers) ? lan.dns.servers : []) {
    if (!IPV4.test(String(server))) {
      errors.push(`${label}: lan.dns.servers entry '${server}' is not a valid IPv4 address`);
    }
  }
  if (lan.dhcpServer?.pool !== undefined && !IP_RANGE.test(String(lan.dhcpServer.pool))) {
    errors.push(`${label}: lan.dhcpServer.pool '${lan.dhcpServer.pool}' must look like 192.168.80.100-192.168.80.200`);
  }
  if (lan.dhcpServer?.leaseTime !== undefined && !DURATION.test(String(lan.dhcpServer.leaseTime))) {
    errors.push(`${label}: lan.dhcpServer.leaseTime '${lan.dhcpServer.leaseTime}' must look like 12h`);
  }

  if (wans.some(w => !w || typeof w !== 'object')) {
    errors.push(`${label}: every wan entry must be a mapping`);
    return { errors, warnings };
  }

  // Check the values that will ACTUALLY be used. Distances and probes are
  // filled in by normalizeWans(), so validating only what the user typed let
  // an implicit default collide with an explicit one and pass.
  let effective = [];
  try {
    effective = normalizeWans(wans);
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
  }
  const effectiveFor = new Map(effective.map(w => [w.name, w]));

  const probes = new Map();
  const pinnedResolvers = new Map();
  const distances = new Map();
  const interfaces = new Map();
  const names = new Set();
  const lanPorts = new Set(Array.isArray(lan.ports) ? lan.ports : []);
  const resolvers = new Set(Array.isArray(lan.dns?.servers) ? lan.dns.servers : []);

  wans.forEach((wan, index) => {
    const name = wan.name || `wan${index + 1}`;

    // Names key route comments, PPPoE client names, APN profile names and the
    // backup map. Two uplinks sharing one would overwrite each other's objects.
    if (wan.name !== undefined) {
      if (!IDENTIFIER.test(String(wan.name))) {
        errors.push(`${label}: wan name '${wan.name}' must start with a letter and use only letters, digits, dot, dash or underscore`);
      }
      if (names.has(wan.name)) {
        errors.push(`${label}: two uplinks are both named '${wan.name}' - names must be unique`);
      }
      names.add(wan.name);
    }

    if (!wan.interface) {
      errors.push(`${label}: ${name} is missing interface`);
    } else {
      if (lanPorts.has(wan.interface)) {
        errors.push(`${label}: ${wan.interface} is listed both as a WAN and in lan.ports - pick one`);
      }
      if (interfaces.has(wan.interface)) {
        errors.push(`${label}: ${name} and ${interfaces.get(wan.interface)} both use ${wan.interface} - one uplink per interface`);
      } else {
        interfaces.set(wan.interface, name);
      }
    }

    const type = wan.type || 'dhcp';
    if (!VALID_WAN_TYPES.includes(type)) {
      errors.push(`${label}: ${name} has invalid type '${type}' (use ${VALID_WAN_TYPES.join(', ')})`);
    }
    if (type === 'static' && !wan.address) {
      errors.push(`${label}: ${name} is type static but has no address`);
    }
    if (type === 'static' && !wan.gateway) {
      errors.push(`${label}: ${name} is type static but has no gateway`);
    }
    if (type === 'static' && wan.address && !CIDR_RE.test(String(wan.address))) {
      errors.push(`${label}: ${name} address '${wan.address}' is not valid CIDR`);
    }
    if (type === 'static' && wan.gateway && !IPV4.test(String(wan.gateway))) {
      errors.push(`${label}: ${name} gateway '${wan.gateway}' is not a valid IPv4 address`);
    }
    if (type === 'pppoe' && !wan.user) {
      errors.push(`${label}: ${name} is type pppoe but has no user`);
    }

    if (wan.distance !== undefined && (!Number.isInteger(wan.distance) || wan.distance < 1 || wan.distance > 255)) {
      errors.push(`${label}: ${name} distance must be a whole number from 1 to 255`);
    }

    // Compare effective distances, so an omitted one colliding with an
    // explicit one is caught too.
    const eff = effectiveFor.get(name);
    const distance = eff ? eff.distance : wan.distance;
    if (distance !== undefined) {
      if (distances.has(distance)) {
        errors.push(`${label}: ${name} and ${distances.get(distance)} both end up at distance ${distance} - each uplink needs its own`);
      } else {
        distances.set(distance, name);
      }
    }

    // Two uplinks probing the same address would fight over one probe route,
    // and the recursive lookup would follow whichever won.
    if (wan.probe !== undefined && !IPV4.test(String(wan.probe))) {
      errors.push(`${label}: ${name} probe '${wan.probe}' is not a valid IPv4 address`);
    }

    // Compare the effective probe, including one assigned by default. The
    // common case - a default probe of 8.8.8.8 alongside lan.dns 8.8.8.8 -
    // used to pass because only explicit probes were checked.
    const probe = eff ? eff.probe : wan.probe;
    if (probe) {
      if (probes.has(probe)) {
        errors.push(`${label}: ${name} and ${probes.get(probe)} both probe ${probe} - each uplink needs its own target`);
      } else {
        probes.set(probe, name);
      }

      // A probe address is pinned to its uplink by a /32 route with no health
      // check. If that uplink is up but the path beyond it is dead, the pin
      // stays and the address is unreachable. A resolver pinned that way
      // stalls every query that picks it, right when the network is degraded.
      if (resolvers.has(probe)) {
        pinnedResolvers.set(probe, name);
      }
    }
  });

  // A probe address is pinned to its uplink by a /32 route with no health
  // check, so if that uplink stays up but loses its path, the address stops
  // answering. Whether that matters depends on what is left:
  //
  //   - Some resolver is not pinned          -> fallback exists. Warn.
  //   - Pinned resolvers span two uplinks    -> one is live whenever any
  //                                             uplink is. Warn.
  //   - Every resolver pinned to one uplink  -> that uplink failing takes DNS
  //                                             out entirely. Error.
  //
  // The middle case is the common real-world one and used to be rejected,
  // which broke working deployments.
  if (pinnedResolvers.size > 0) {
    const unpinned = [...resolvers].filter(r => !pinnedResolvers.has(r));
    const uplinksHoldingResolvers = new Set(pinnedResolvers.values());
    const pinnedList = [...pinnedResolvers.entries()]
      .map(([addr, uplink]) => `${addr} (${uplink})`)
      .join(', ');

    if (unpinned.length === 0 && uplinksHoldingResolvers.size < 2) {
      errors.push(
        `${label}: every lan.dns resolver is pinned to the same uplink as a probe target - ${pinnedList}. ` +
        'If that uplink stays up but loses its path, every resolver becomes unreachable and DNS stops. ' +
        'Add a resolver that is not a probe target, or spread the probes across uplinks.'
      );
    } else {
      const why = unpinned.length > 0
        ? `${unpinned.join(', ')} stays reachable, so lookups fall back`
        : 'they are pinned to different uplinks, so one stays reachable';
      warnings.push(
        `${label}: these resolvers are also probe targets - ${pinnedList}. ` +
        `If an uplink stays up but loses its path, queries to its resolver stall until they time out; ${why}.`
      );
    }
  }

  return { errors, warnings };
}

module.exports = { validateRouterConfig, VALID_WAN_TYPES };
