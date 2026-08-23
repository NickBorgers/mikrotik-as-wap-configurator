/**
 * Router role configuration validation
 *
 * Lives in its own module because both entry points need it: apply-config.js
 * for a single device and apply-multiple-devices.js for a fleet. It used to
 * exist only in apply-config.js, which meant a router inside a multi-device
 * deployment was applied with no validation at all.
 */

const VALID_WAN_TYPES = ['dhcp', 'static', 'pppoe', 'lte'];
const CIDR_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;

/**
 * Validate the lan and wan blocks of a router-role configuration.
 *
 * @param {Object} config - Device configuration
 * @param {string} label - Prefix for error messages, e.g. "Device 2"
 * @returns {string[]} - Error strings, empty when valid
 */
function validateRouterConfig(config, label = 'Router') {
  const errors = [];
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
    return errors;
  }

  const probes = new Map();
  const distances = new Map();
  const interfaces = new Map();
  const lanPorts = new Set(lan.ports || []);
  const resolvers = new Set(lan.dns?.servers || []);

  wans.forEach((wan, index) => {
    const name = wan.name || `wan[${index}]`;

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
    if (type === 'pppoe' && !wan.user) {
      errors.push(`${label}: ${name} is type pppoe but has no user`);
    }

    if (wan.distance !== undefined) {
      if (!Number.isInteger(wan.distance) || wan.distance < 1 || wan.distance > 255) {
        errors.push(`${label}: ${name} distance must be a whole number from 1 to 255`);
      } else if (distances.has(wan.distance)) {
        errors.push(`${label}: ${name} and ${distances.get(wan.distance)} share distance ${wan.distance} - each uplink needs its own`);
      } else {
        distances.set(wan.distance, name);
      }
    }

    // Two uplinks probing the same address would fight over one probe route,
    // and the recursive lookup would follow whichever won.
    if (wan.probe) {
      if (probes.has(wan.probe)) {
        errors.push(`${label}: ${name} and ${probes.get(wan.probe)} both probe ${wan.probe} - each uplink needs its own target`);
      } else {
        probes.set(wan.probe, name);
      }

      // A probe address is pinned to its uplink by a /32 route with no health
      // check. If that uplink is up but the path beyond it is dead, the pin
      // stays and the address is unreachable. A resolver pinned that way
      // stalls every query that picks it, right when the network is degraded.
      if (resolvers.has(wan.probe)) {
        errors.push(
          `${label}: ${wan.probe} is both ${name}'s probe target and a lan.dns resolver. ` +
          'The probe pins it to that uplink, so it becomes unreachable when that uplink fails. Use different addresses.'
        );
      }
    }
  });

  return errors;
}

module.exports = { validateRouterConfig, VALID_WAN_TYPES };
