/**
 * WiFi Access List configuration for WAP locking
 * Locks specific WiFi clients to specific access points using access-list rules
 */

const { MikroTikSSH } = require('./ssh-client');
const { getWifiPath, getCapsmanPath } = require('./utils');
const { detectWifiPackage } = require('./infrastructure');

/**
 * Extract hostname from FQDN
 * @param {string} host - FQDN like "shed-wap.nickborgers.net"
 * @returns {string} - Hostname like "shed-wap"
 */
function extractHostname(host) {
  if (!host) return '';
  if (host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    // IP address - can't extract hostname
    return host;
  }
  return host.split('.')[0];
}

/**
 * Discover all WiFi interfaces serving a specific SSID
 * @param {MikroTikSSH} mt - SSH connection to controller
 * @param {string} ssid - SSID name to search for
 * @param {string} wifiPath - WiFi path (e.g., /interface/wifi)
 * @returns {Promise<Array<{name: string, band: string}>>} - Array of interface names and bands
 */
async function discoverSsidInterfaces(mt, ssid, wifiPath) {
  const interfaces = [];

  try {
    // Get all WiFi interfaces
    const output = await mt.exec(`${wifiPath} print terse`);

    // First pass: get all interface names
    const allInterfaceNames = [];
    for (const line of output.split('\n')) {
      const nameMatch = line.match(/(?:^|\s)name=([^\s]+)/);
      if (nameMatch) {
        allInterfaceNames.push(nameMatch[1]);
      }
    }

    // Second pass: check each interface for the SSID
    for (const ifaceName of allInterfaceNames) {
      try {
        const detail = await mt.exec(`${wifiPath} print detail where name="${ifaceName}"`);

        // Check if this interface serves the target SSID
        // Match both full format and shorthand
        const ssidMatch = detail.match(/(?:configuration)?\.ssid="([^"]+)"/);
        if (ssidMatch && ssidMatch[1] === ssid) {
          // Determine band from interface name
          let band = 'unknown';
          if (ifaceName.includes('-2g') || ifaceName.includes('wifi1')) {
            band = '2.4GHz';
          } else if (ifaceName.includes('-5g') || ifaceName.includes('wifi2')) {
            band = '5GHz';
          }

          interfaces.push({ name: ifaceName, band });
        }
      } catch (e) {
        // Skip interfaces we can't read
      }
    }
  } catch (e) {
    console.log(`⚠️  Could not discover SSID interfaces: ${e.message}`);
  }

  return interfaces;
}

/**
 * Discover all WiFi interfaces on the controller (both local and CAP)
 * @param {MikroTikSSH} mt - SSH connection to controller
 * @param {string} wifiPath - WiFi path
 * @returns {Promise<Array<{name: string, ssid: string, band: string, apIdentity: string}>>}
 */
async function discoverAllInterfaces(mt, wifiPath) {
  const interfaces = [];

  try {
    const output = await mt.exec(`${wifiPath} print detail without-paging`);

    // Parse interfaces
    let currentInterface = null;

    for (const line of output.split('\n')) {
      // New interface entry starts with a number
      if (line.match(/^\s*\d+\s/)) {
        if (currentInterface && currentInterface.ssid) {
          interfaces.push(currentInterface);
        }
        currentInterface = { raw: line };
      } else if (currentInterface && line.trim()) {
        currentInterface.raw += ' ' + line.trim();
      }
    }

    // Don't forget the last interface
    if (currentInterface && currentInterface.raw) {
      const nameMatch = currentInterface.raw.match(/(?:^|\s)name="?([^\s"]+)"?/);
      const ssidMatch = currentInterface.raw.match(/(?:configuration)?\.ssid="([^"]+)"/);
      const disabledMatch = currentInterface.raw.match(/disabled=yes/);

      if (nameMatch && ssidMatch && !disabledMatch) {
        const name = nameMatch[1];
        const ssid = ssidMatch[1];

        // Determine band from interface name
        let band = 'unknown';
        if (name.includes('-2g') || name.includes('wifi1')) {
          band = '2.4GHz';
        } else if (name.includes('-5g') || name.includes('wifi2')) {
          band = '5GHz';
        }

        // Determine AP identity from interface name
        // CAP interfaces: managed-wap-north-2g -> managed-wap-north
        // Local interfaces: wifi1 -> (controller identity)
        let apIdentity = '';
        if (name.match(/-2g(-ssid\d+)?$/) || name.match(/-5g(-ssid\d+)?$/)) {
          // CAP interface
          apIdentity = name.replace(/-2g(-ssid\d+)?$/, '').replace(/-5g(-ssid\d+)?$/, '');
        } else {
          // Local controller interface
          apIdentity = '_controller_';
        }

        interfaces.push({ name, ssid, band, apIdentity });
      }
    }

    // Re-parse properly for all interfaces
    interfaces.length = 0;
    const lines = output.split('\n');
    let buffer = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^\s*\d+\s/)) {
        // Process previous buffer
        if (buffer) {
          processInterfaceBuffer(buffer, interfaces);
        }
        buffer = line;
      } else if (buffer && line.trim()) {
        buffer += ' ' + line.trim();
      }
    }
    // Process last buffer
    if (buffer) {
      processInterfaceBuffer(buffer, interfaces);
    }

  } catch (e) {
    console.log(`⚠️  Could not discover interfaces: ${e.message}`);
  }

  return interfaces;
}

/**
 * Process a single interface buffer and add to interfaces array
 */
function processInterfaceBuffer(buffer, interfaces) {
  const nameMatch = buffer.match(/(?:^|\s)name="?([^\s"]+)"?/);
  const ssidMatch = buffer.match(/(?:configuration)?\.ssid="([^"]+)"/);
  const disabledMatch = buffer.match(/disabled=yes/);

  if (nameMatch && ssidMatch && !disabledMatch) {
    const name = nameMatch[1];
    const ssid = ssidMatch[1];

    // Determine band from interface name
    let band = 'unknown';
    if (name.includes('-2g') || name.includes('wifi1')) {
      band = '2.4GHz';
    } else if (name.includes('-5g') || name.includes('wifi2')) {
      band = '5GHz';
    }

    // Determine AP identity from interface name
    let apIdentity = '';
    if (name.match(/-2g(-ssid\d+)?$/) || name.match(/-5g(-ssid\d+)?$/)) {
      apIdentity = name.replace(/-2g(-ssid\d+)?$/, '').replace(/-5g(-ssid\d+)?$/, '');
    } else {
      apIdentity = '_controller_';
    }

    interfaces.push({ name, ssid, band, apIdentity });
  }
}

/**
 * Configure access-list rules for locked devices on the CAPsMAN controller
 * @param {Object} controllerConfig - Controller configuration (host, username, password)
 * @param {Array<Object>} lockedDevices - Array of locked device configs
 *        Each should have: { mac, hostname, lockToAp, ssid? }
 * @param {Array<Object>} deploymentSsids - Array of SSIDs in the deployment
 * @param {Array<Object>} devices - Full device configs (for determining controller identity)
 * @returns {Promise<boolean>} - Success status
 */
async function configureAccessLists(controllerConfig, lockedDevices, deploymentSsids, devices) {
  if (!lockedDevices || lockedDevices.length === 0) {
    console.log('ℹ️  No locked devices to configure');
    return true;
  }

  const mt = new MikroTikSSH(
    controllerConfig.host || '192.168.88.1',
    controllerConfig.username || 'admin',
    controllerConfig.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('Configuring WiFi Access-Lists (WAP Locking)');
    console.log('========================================\n');

    // Detect WiFi package
    const wifiPackage = await detectWifiPackage(mt);
    if (!wifiPackage) {
      console.log('✗ Could not detect WiFi package');
      await mt.close();
      return false;
    }

    const wifiPath = getWifiPath(wifiPackage);

    // Determine controller identity
    let controllerIdentity = '_controller_';
    const controller = devices.find(d => d.role === 'controller');
    if (controller) {
      controllerIdentity = controller.identity || extractHostname(controller.device?.host);
    }

    // Discover all WiFi interfaces on the controller
    console.log('=== Discovering WiFi Interfaces ===');
    const allInterfaces = await discoverAllInterfaces(mt, wifiPath);

    // Replace _controller_ placeholder with actual controller identity
    for (const iface of allInterfaces) {
      if (iface.apIdentity === '_controller_') {
        iface.apIdentity = controllerIdentity;
      }
    }

    console.log(`Found ${allInterfaces.length} WiFi interface(s):`);
    const byAp = {};
    for (const iface of allInterfaces) {
      if (!byAp[iface.apIdentity]) byAp[iface.apIdentity] = [];
      byAp[iface.apIdentity].push(`${iface.name} (${iface.ssid})`);
    }
    for (const [ap, ifaces] of Object.entries(byAp)) {
      console.log(`  ${ap}: ${ifaces.join(', ')}`);
    }

    // Remove existing access-list rules for locked device MACs (idempotent)
    console.log('\n=== Cleaning Up Old Access-List Rules ===');
    for (const lockedDevice of lockedDevices) {
      const mac = lockedDevice.mac.toUpperCase();
      try {
        const existing = await mt.exec(`${wifiPath}/access-list print terse where mac-address="${mac}"`);
        if (existing && existing.trim()) {
          await mt.exec(`${wifiPath}/access-list remove [find mac-address="${mac}"]`);
          console.log(`  ✓ Removed old rules for ${mac} (${lockedDevice.hostname})`);
        }
      } catch (e) {
        if (!e.message.includes('no such item')) {
          console.log(`  ⚠️  Could not clean rules for ${mac}: ${e.message}`);
        }
      }
    }

    // Configure access-list rules for each locked device
    console.log('\n=== Creating Access-List Rules ===');

    for (const lockedDevice of lockedDevices) {
      const { mac, hostname, lockToAp, ssid } = lockedDevice;
      const macUpper = mac.toUpperCase();

      console.log(`\nLocking ${hostname} (${mac}) to ${lockToAp}${ssid ? ` on SSID: ${ssid}` : ' (all SSIDs)'}`);

      // Find interfaces for this locked device
      let targetInterfaces;
      let otherInterfaces;

      if (ssid) {
        // Lock to specific SSID
        targetInterfaces = allInterfaces.filter(i =>
          i.ssid === ssid && i.apIdentity === lockToAp
        );
        otherInterfaces = allInterfaces.filter(i =>
          i.ssid === ssid && i.apIdentity !== lockToAp
        );
      } else {
        // Lock to all SSIDs this device serves
        // Find which SSIDs the target AP serves
        const targetSsids = [...new Set(allInterfaces
          .filter(i => i.apIdentity === lockToAp)
          .map(i => i.ssid))];

        targetInterfaces = allInterfaces.filter(i =>
          i.apIdentity === lockToAp
        );
        otherInterfaces = allInterfaces.filter(i =>
          targetSsids.includes(i.ssid) && i.apIdentity !== lockToAp
        );
      }

      if (targetInterfaces.length === 0) {
        console.log(`  ⚠️  No interfaces found for ${lockToAp}${ssid ? ` with SSID ${ssid}` : ''}`);
        continue;
      }

      // Create ACCEPT rules for target AP
      for (const iface of targetInterfaces) {
        const comment = `${hostname} - lock to ${lockToAp}`;
        try {
          await mt.exec(
            `${wifiPath}/access-list add mac-address="${macUpper}" interface=${iface.name} action=accept comment="${comment}"`
          );
          console.log(`  ✓ ACCEPT on ${iface.name} (${iface.ssid})`);
        } catch (e) {
          console.log(`  ⚠️  Could not add accept rule for ${iface.name}: ${e.message}`);
        }
      }

      // Create REJECT rules for other APs
      for (const iface of otherInterfaces) {
        const comment = `${hostname} - reject (locked to ${lockToAp})`;
        try {
          await mt.exec(
            `${wifiPath}/access-list add mac-address="${macUpper}" interface=${iface.name} action=reject comment="${comment}"`
          );
          console.log(`  ✓ REJECT on ${iface.name} (${iface.ssid})`);
        } catch (e) {
          console.log(`  ⚠️  Could not add reject rule for ${iface.name}: ${e.message}`);
        }
      }
    }

    console.log('\n========================================');
    console.log('✓ Access-List Configuration Complete');
    console.log('========================================\n');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ Access-List Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

/**
 * Backup access-list rules from controller and reconstruct lockedDevices config
 * @param {MikroTikSSH} mt - SSH connection to controller
 * @param {string} wifiPath - WiFi path
 * @returns {Promise<Array<Object>>} - Array of { mac, hostname, lockToAp, ssid? }
 */
async function backupAccessLists(mt, wifiPath) {
  const lockedDevices = [];

  try {
    console.log('\n=== Reading Access-List Configuration ===');

    const output = await mt.exec(`${wifiPath}/access-list print detail without-paging`);

    if (!output || !output.trim() || output.includes('no such item')) {
      console.log('  No access-list rules found');
      return lockedDevices;
    }

    // Parse access-list entries
    // Format: mac-address=XX:XX:XX:XX:XX:XX interface=<name> action=accept/reject comment="hostname - lock to ap"
    const rules = [];
    const lines = output.split('\n');
    let buffer = '';

    for (const line of lines) {
      if (line.match(/^\s*\d+\s/)) {
        if (buffer) {
          parseAccessListRule(buffer, rules);
        }
        buffer = line;
      } else if (buffer && line.trim()) {
        buffer += ' ' + line.trim();
      }
    }
    if (buffer) {
      parseAccessListRule(buffer, rules);
    }

    // Group rules by MAC address to reconstruct locked device configs
    const byMac = new Map();
    for (const rule of rules) {
      if (!byMac.has(rule.mac)) {
        byMac.set(rule.mac, []);
      }
      byMac.get(rule.mac).push(rule);
    }

    // For each MAC, determine the lock configuration
    for (const [mac, macRules] of byMac) {
      const acceptRules = macRules.filter(r => r.action === 'accept');
      const rejectRules = macRules.filter(r => r.action === 'reject');

      if (acceptRules.length === 0) continue;

      // Extract hostname and lockToAp from comment
      // Comment format: "hostname - lock to ap" or "hostname - reject (locked to ap)"
      let hostname = '';
      let lockToAp = '';

      for (const rule of acceptRules) {
        if (rule.comment) {
          const lockMatch = rule.comment.match(/^(.+?)\s+-\s+lock to\s+(.+)$/);
          if (lockMatch) {
            hostname = lockMatch[1];
            lockToAp = lockMatch[2];
            break;
          }
        }
      }

      if (!hostname || !lockToAp) {
        // Try to infer from interface name
        const firstAccept = acceptRules[0];
        if (firstAccept.interface) {
          // Extract AP identity from interface name
          lockToAp = firstAccept.interface
            .replace(/-2g(-ssid\d+)?$/, '')
            .replace(/-5g(-ssid\d+)?$/, '')
            .replace(/^wifi\d+$/, 'controller');
        }
        hostname = mac.replace(/:/g, '').toLowerCase();
      }

      // Determine if locked to specific SSID
      // If all accept rules are for the same SSID, it's a specific SSID lock
      const acceptSsids = [...new Set(acceptRules.map(r => r.ssid).filter(Boolean))];
      const ssid = acceptSsids.length === 1 ? acceptSsids[0] : undefined;

      const lockedDevice = {
        hostname,
        mac,
        lockToAp
      };
      if (ssid) {
        lockedDevice.ssid = ssid;
      }

      lockedDevices.push(lockedDevice);
      console.log(`  ✓ Found locked device: ${hostname} (${mac}) → ${lockToAp}${ssid ? ` [${ssid}]` : ''}`);
    }

  } catch (e) {
    if (!e.message.includes('no such item')) {
      console.log(`⚠️  Could not read access-list: ${e.message}`);
    }
  }

  return lockedDevices;
}

/**
 * Parse a single access-list rule line
 */
function parseAccessListRule(buffer, rules) {
  const macMatch = buffer.match(/mac-address=([0-9A-Fa-f:]+)/);
  const interfaceMatch = buffer.match(/interface=([^\s]+)/);
  const actionMatch = buffer.match(/action=(accept|reject)/);
  const commentMatch = buffer.match(/comment="([^"]+)"/);

  if (macMatch) {
    const rule = {
      mac: macMatch[1].toUpperCase(),
      interface: interfaceMatch ? interfaceMatch[1] : '',
      action: actionMatch ? actionMatch[1] : 'accept',
      comment: commentMatch ? commentMatch[1] : ''
    };

    // Try to extract SSID from interface name (we don't have it directly)
    // This will be filled in during the grouping phase if needed
    rule.ssid = '';

    rules.push(rule);
  }
}

module.exports = {
  configureAccessLists,
  backupAccessLists,
  extractHostname
};
