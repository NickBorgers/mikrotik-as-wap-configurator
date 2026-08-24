/**
 * Router role configuration validation
 *
 * Lives in its own module because both entry points need it: apply-config.js
 * for a single device and apply-multiple-devices.js for a fleet. It used to
 * exist only in apply-config.js, which meant a router inside a multi-device
 * deployment was applied with no validation at all.
 */

const { CIDR, IPV4, IP_RANGE, DURATION, IDENTIFIER } = require('./routeros-args');
const { normalizeWans } = require('./router');

const VALID_WAN_TYPES = ['dhcp', 'static', 'pppoe', 'lte'];
// Shape alone is not enough: 999.999.999.999/99 matched the old pattern.
const CIDR_RE = CIDR;

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

  if (!Array.isArray(wans) || wans.length === 0) {
    errors.push(`${label}: wan must be a non-empty list of uplinks`);
    return { errors, warnings };
  }

  if (lan.ports !== undefined && !Array.isArray(lan.ports)) {
    errors.push(`${label}: lan.ports must be a list`);
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
