/**
 * Infrastructure configuration helpers
 * Bridge, DHCP, bonding, syslog, and management interface setup
 */

/**
 * Execute a command idempotently - handles "already exists" errors gracefully
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} command - Command to execute
 * @param {string} successMsg - Message to show on success
 * @param {string[]} alreadyDonePatterns - Patterns indicating operation already complete
 * @returns {boolean} - True if successful or already done
 */
async function execIdempotent(mt, command, successMsg, alreadyDonePatterns = ['already have', 'exists']) {
  try {
    await mt.exec(command);
    console.log(`✓ ${successMsg}`);
    return true;
  } catch (e) {
    if (alreadyDonePatterns.some(p => e.message.includes(p))) {
      console.log(`✓ ${successMsg} (already done)`);
      return true;
    }
    throw e;
  }
}

/**
 * Execute a command, logging warning on failure instead of throwing
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} command - Command to execute
 * @param {string} successMsg - Message to show on success
 * @param {string} warningPrefix - Prefix for warning message on failure
 */
async function execWithWarning(mt, command, successMsg, warningPrefix) {
  try {
    await mt.exec(command);
    console.log(`✓ ${successMsg}`);
  } catch (e) {
    console.log(`⚠️  ${warningPrefix}: ${e.message}`);
  }
}

/**
 * Set device identity based on hostname from FQDN
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} config - Configuration with host and optional identity
 * @returns {string|null} - The identity that was set, or null
 */
async function setDeviceIdentity(mt, config) {
  console.log('=== Setting Device Identity ===');

  let deviceIdentity = config.identity;

  if (!deviceIdentity && config.host) {
    if (config.host.includes('.') && !config.host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      deviceIdentity = config.host.split('.')[0];
      console.log(`✓ Extracted hostname from FQDN: ${deviceIdentity}`);
    } else if (!config.host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      deviceIdentity = config.host;
      console.log(`✓ Using host as identity: ${deviceIdentity}`);
    }
  }

  if (deviceIdentity) {
    try {
      await mt.exec(`/system identity set name="${deviceIdentity}"`);
      console.log(`✓ Device identity set to: ${deviceIdentity}`);
    } catch (e) {
      console.log(`⚠️  Could not set device identity: ${e.message}`);
    }
  } else {
    console.log('⚠️  No hostname found to set as identity (using IP address for connection)');
  }

  return deviceIdentity;
}

/**
 * Detect WiFi package type (wifiwave2 or wifi-qcom)
 * @param {MikroTikSSH} mt - Connected SSH session
 * @returns {string|null} - 'wifiwave2', 'wifi-qcom', or null if not found
 */
async function detectWifiPackage(mt) {
  console.log('\n=== Detecting WiFi Package ===');

  const packages = await mt.exec('/system package print terse where name~"wifi"');

  if (packages.includes('wifiwave2')) {
    console.log('✓ Using WiFiWave2 package');
    return 'wifiwave2';
  } else if (packages.includes('wifi-qcom') || packages.includes('wifi ')) {
    console.log('✓ Using WiFi-QCOM package');
    return 'wifi-qcom';
  }

  console.log('✗ No supported WiFi package found');
  return null;
}

/**
 * Ensure bridge exists and disable VLAN filtering
 * @param {MikroTikSSH} mt - Connected SSH session
 */
async function ensureBridgeInfrastructure(mt) {
  console.log('\n=== Ensuring Basic Infrastructure ===');

  // Check if bridge exists, create if not
  try {
    const bridges = await mt.exec('/interface bridge print terse where name=bridge');
    if (!bridges || !bridges.trim()) {
      await mt.exec('/interface bridge add name=bridge');
      console.log('✓ Created bridge');
    } else {
      console.log('✓ Bridge already exists');
    }
  } catch (e) {
    try {
      await mt.exec('/interface bridge add name=bridge');
      console.log('✓ Created bridge');
    } catch (addErr) {
      if (addErr.message.includes('already')) {
        console.log('✓ Bridge already exists');
      } else {
        console.log('⚠️  Could not verify/create bridge: ' + addErr.message);
      }
    }
  }

  // Disable VLAN filtering for safety
  try {
    await mt.exec('/interface bridge set bridge vlan-filtering=no');
    console.log('✓ VLAN filtering disabled (safe for management)');
  } catch (e) {
    console.log(`⚠️  Could not disable VLAN filtering: ${e.message}`);
  }
}

/**
 * Configure LACP bond with deterministic MAC address for DHCP static leases
 * Uses forced-mac-address from primary interface to ensure consistent MAC
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Array} bondMembers - Array of interface names to bond (e.g., ['ether1', 'ether2'])
 * @param {string} bondName - Name for the bond interface (default: 'bond1')
 * @returns {string} - The bond interface name
 */
async function configureLacpBond(mt, bondMembers, bondName = 'bond1') {
  console.log(`\n=== Configuring LACP Bond (${bondName}) ===`);

  // First, remove bond members from bridge if they're already added
  for (const member of bondMembers) {
    try {
      await mt.exec(`/interface bridge port remove [find interface=${member}]`);
      console.log(`✓ Removed ${member} from bridge (preparing for bond)`);
    } catch (e) {
      // Interface might not be in bridge
    }
  }

  // Remove DHCP clients from bond member interfaces
  // DHCP clients can't run on slave interfaces and cause routing issues
  for (const member of bondMembers) {
    try {
      await mt.exec(`/ip dhcp-client remove [find interface=${member}]`);
      console.log(`✓ Removed DHCP client from ${member} (can't run on bond slave)`);
    } catch (e) {
      // No DHCP client on this interface, or already removed
    }
  }

  // Get ORIGINAL MAC address of first interface BEFORE creating bond
  // Must use orig-mac-address, not mac-address, since current MAC might be
  // modified by previous bonding configuration
  let primaryMac = null;
  try {
    const ethDetail = await mt.exec(`/interface ethernet print detail where default-name=${bondMembers[0]}`);
    // Use orig-mac-address to get the original hardware MAC
    const macMatch = ethDetail.match(/orig-mac-address=([0-9A-Fa-f:]+)/);
    if (macMatch) {
      primaryMac = macMatch[1];
      console.log(`✓ Using ${bondMembers[0]} original MAC for bond: ${primaryMac}`);
    } else {
      // Fallback to mac-address if orig-mac-address not found
      const fallbackMatch = ethDetail.match(/mac-address=([0-9A-Fa-f:]+)/);
      if (fallbackMatch) {
        primaryMac = fallbackMatch[1];
        console.log(`✓ Using ${bondMembers[0]} MAC for bond: ${primaryMac} (orig MAC not found)`);
      }
    }
  } catch (e) {
    console.log(`⚠️  Could not read ${bondMembers[0]} MAC address: ${e.message}`);
  }

  // Create or update bond interface
  try {
    // First check if bond exists
    const bondCheck = await mt.exec(`/interface bonding print where name=${bondName}`);

    // Build bond command with forced-mac-address if we have it
    const macParam = primaryMac ? ` forced-mac-address=${primaryMac}` : '';

    if (!bondCheck || bondCheck.includes('no such item') || !bondCheck.includes(bondName)) {
      // Create new bond with LACP (802.3ad mode)
      // Use forced-mac-address to ensure consistent MAC for DHCP static leases
      await mt.exec(`/interface bonding add name=${bondName} slaves="${bondMembers.join(',')}" mode=802.3ad lacp-rate=30secs transmit-hash-policy=layer-2-and-3${macParam}`);
      console.log(`✓ Created LACP bond ${bondName} with members: ${bondMembers.join(', ')}`);
    } else {
      // Update existing bond
      await mt.exec(`/interface bonding set [find name=${bondName}] slaves="${bondMembers.join(',')}" mode=802.3ad lacp-rate=30secs transmit-hash-policy=layer-2-and-3${macParam}`);
      console.log(`✓ Updated LACP bond ${bondName} with members: ${bondMembers.join(', ')}`);
    }
  } catch (e) {
    console.log(`⚠️  Bond configuration error: ${e.message}`);
    // Try alternative approach for existing bonds
    const macParam = primaryMac ? ` forced-mac-address=${primaryMac}` : '';
    try {
      await mt.exec(`/interface bonding remove [find name=${bondName}]`);
      await mt.exec(`/interface bonding add name=${bondName} slaves="${bondMembers.join(',')}" mode=802.3ad lacp-rate=30secs transmit-hash-policy=layer-2-and-3${macParam}`);
      console.log(`✓ Recreated LACP bond ${bondName}`);
    } catch (e2) {
      console.log(`✗ Failed to configure bond: ${e2.message}`);
    }
  }

  // Add bond to bridge
  try {
    await mt.exec(`/interface bridge port add bridge=bridge interface=${bondName}`);
    console.log(`✓ Added ${bondName} to bridge`);
  } catch (e) {
    if (e.message.includes('already have interface')) {
      console.log(`✓ ${bondName} already in bridge`);
    } else {
      console.log(`⚠️  Could not add bond to bridge: ${e.message}`);
    }
  }

  // Enable all bond member interfaces
  for (const member of bondMembers) {
    try {
      await mt.exec(`/interface ethernet set [find default-name=${member}] disabled=no`);
      console.log(`✓ Enabled ${member} for bonding`);
    } catch (e) {
      console.log(`⚠️  Could not enable ${member}: ${e.message}`);
    }
  }

  return { bondName, primaryMac };
}

/**
 * Set bridge admin-mac to ensure consistent MAC for DHCP
 * This is critical for static DHCP leases - the bridge MAC determines the DHCP client MAC
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} macAddress - MAC address to set on bridge
 */
async function setBridgeAdminMac(mt, macAddress) {
  if (!macAddress) {
    console.log('⚠️  No MAC address provided for bridge');
    return;
  }

  try {
    await mt.exec(`/interface bridge set bridge auto-mac=no admin-mac=${macAddress}`);
    console.log(`✓ Set bridge admin-mac=${macAddress} (DHCP will use this MAC)`);
  } catch (e) {
    console.log(`⚠️  Could not set bridge admin-mac: ${e.message}`);
  }
}

/**
 * Configure management interfaces (simple interfaces or LACP bonds)
 * Also sets bridge admin-mac to match the primary management interface MAC
 * for consistent DHCP static lease behavior
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} config - Configuration with managementInterfaces array
 */
async function configureManagementInterfaces(mt, config) {
  console.log('\n=== Configuring Management Interfaces ===');

  const mgmtInterfaces = config.managementInterfaces || ['ether1'];
  let managementMac = null;

  for (const iface of mgmtInterfaces) {
    if (typeof iface === 'string') {
      try {
        await execIdempotent(
          mt,
          `/interface bridge port add bridge=bridge interface=${iface}`,
          `Added ${iface} to bridge`,
          ['already have interface']
        );
        // For simple interfaces, get the MAC of the first management interface
        if (!managementMac) {
          try {
            const ethDetail = await mt.exec(`/interface ethernet print detail where default-name=${iface}`);
            const macMatch = ethDetail.match(/orig-mac-address=([0-9A-Fa-f:]+)/);
            if (macMatch) {
              managementMac = macMatch[1];
              console.log(`✓ Using ${iface} MAC for bridge: ${managementMac}`);
            }
          } catch (e) {
            console.log(`⚠️  Could not read ${iface} MAC: ${e.message}`);
          }
        }
      } catch (e) {
        console.log(`⚠️  Could not add ${iface}: ${e.message}`);
      }
    } else if (iface.bond && Array.isArray(iface.bond)) {
      const { primaryMac } = await configureLacpBond(mt, iface.bond);
      // For bonds, use the bond's forced-mac-address (which comes from first bond member)
      if (primaryMac && !managementMac) {
        managementMac = primaryMac;
      }
    }
  }

  // Set bridge admin-mac to match management interface MAC
  // This ensures DHCP client uses the correct MAC for static leases
  if (managementMac) {
    await setBridgeAdminMac(mt, managementMac);
  }
}

/**
 * Disable specified interfaces
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} config - Configuration with disabledInterfaces array
 */
async function configureDisabledInterfaces(mt, config) {
  const disabledInterfaces = config.disabledInterfaces || [];

  for (const iface of disabledInterfaces) {
    await execWithWarning(
      mt,
      `/interface ethernet set [find default-name=${iface}] disabled=yes`,
      `Disabled ${iface}`,
      `Could not disable ${iface}`
    );
  }
}

/**
 * Enable DHCP client on bridge
 * @param {MikroTikSSH} mt - Connected SSH session
 */
async function enableDhcpClient(mt) {
  console.log('\n=== Establishing Management via DHCP ===');

  try {
    await execIdempotent(
      mt,
      '/ip dhcp-client add interface=bridge disabled=no',
      'Added DHCP client on bridge',
      ['already have']
    );
  } catch (e) {
    console.log(`⚠️  DHCP client: ${e.message}`);
  }
}

/**
 * Configure remote syslog
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} config - Configuration with syslog settings
 */
async function configureSyslog(mt, config) {
  if (!config.syslog || !config.syslog.server) {
    return;
  }

  console.log('\n=== Configuring Remote Syslog ===');

  const syslogServer = config.syslog.server;
  const syslogPort = config.syslog.port || 514;
  const syslogTopics = config.syslog.topics || ['wireless'];
  const syslogActionName = 'remotesyslog';

  // Remove existing syslog configuration (idempotency)
  try {
    await mt.exec(`/system logging action remove [find name="${syslogActionName}"]`);
  } catch (e) { /* ignore */ }

  try {
    await mt.exec(`/system logging remove [find action="${syslogActionName}"]`);
  } catch (e) { /* ignore */ }

  try {
    await mt.exec(
      `/system logging action add name="${syslogActionName}" target=remote ` +
      `remote=${syslogServer} remote-port=${syslogPort}`
    );

    for (const topic of syslogTopics) {
      await mt.exec(`/system logging add topics=${topic} action="${syslogActionName}"`);
    }

    console.log(`✓ Syslog configured: ${syslogServer}:${syslogPort}`);
    console.log(`  Topics: ${syslogTopics.join(', ')}`);
  } catch (e) {
    console.log(`⚠️  Syslog config: ${e.message}`);
  }
}

/**
 * Configure IGMP snooping on the bridge
 * IGMP snooping optimizes multicast traffic by forwarding it only to ports
 * that have interested receivers, reducing unnecessary network load.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {boolean} enabled - Whether to enable IGMP snooping
 */
async function configureIgmpSnooping(mt, enabled) {
  const value = enabled ? 'yes' : 'no';
  try {
    await mt.exec(`/interface bridge set bridge igmp-snooping=${value}`);
    console.log(`✓ IGMP snooping ${enabled ? 'enabled' : 'disabled'}`);
  } catch (e) {
    console.log(`⚠️  Could not configure IGMP snooping: ${e.message}`);
  }
}

/**
 * Ensure all WiFi interfaces (including virtual interfaces) are added to the bridge
 * This is necessary for IGMP snooping to work correctly on CAP devices where
 * virtual interfaces may not be automatically added as bridge ports.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path (/interface/wifi or /interface/wifiwave2)
 * @returns {number} - Number of interfaces added to bridge
 */
async function ensureWifiInterfacesInBridge(mt, wifiPath) {
  let addedCount = 0;

  try {
    // Get all WiFi interfaces (master and virtual)
    const wifiOutput = await mt.exec(`${wifiPath} print terse without-paging`);

    // Get existing bridge ports
    const bridgePortsOutput = await mt.exec('/interface bridge port print terse without-paging');
    const existingPorts = new Set();
    for (const line of bridgePortsOutput.split('\n')) {
      const ifaceMatch = line.match(/interface=([^\s]+)/);
      if (ifaceMatch) {
        existingPorts.add(ifaceMatch[1]);
      }
    }

    // Parse WiFi interfaces
    const wifiInterfaces = [];
    for (const line of wifiOutput.split('\n')) {
      if (!line.trim()) continue;
      const nameMatch = line.match(/name="?([^"\s]+)"?/);
      if (nameMatch) {
        wifiInterfaces.push(nameMatch[1]);
      }
    }

    // Add missing interfaces to bridge
    for (const iface of wifiInterfaces) {
      if (!existingPorts.has(iface)) {
        try {
          await mt.exec(`/interface bridge port add bridge=bridge interface=${iface}`);
          console.log(`  ✓ Added ${iface} to bridge`);
          addedCount++;
        } catch (e) {
          if (e.message.includes('already have interface')) {
            // Interface was added between our check and add - that's fine
          } else {
            console.log(`  ⚠️  Could not add ${iface} to bridge: ${e.message}`);
          }
        }
      }
    }

    if (addedCount === 0) {
      console.log('  ✓ All WiFi interfaces already in bridge');
    }
  } catch (e) {
    console.log(`⚠️  Could not ensure WiFi interfaces in bridge: ${e.message}`);
  }

  return addedCount;
}

/**
 * Configure dedicated CAPsMAN VLAN for L2 CAP↔Controller connectivity
 * Creates VLAN interface, assigns static IP, and adds firewall rules
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Object} config - Device configuration containing capsmanVlan and capsmanAddress
 * @returns {string|null} - The configured static IP or null if not configured
 */
async function configureCapsmanVlan(mt, config) {
  // Support unified format (capsman.vlan) and legacy formats (cap.capsmanVlan, capsmanVlan)
  const capsmanConfig = config.capsman || {};
  const capConfig = config.cap || {};

  // New unified: capsman.vlan.id, Legacy: cap.capsmanVlan.vlan, capsmanVlan.vlan
  const vlanConfig = capsmanConfig.vlan || capConfig.capsmanVlan || config.capsmanVlan || {};
  const vlanId = vlanConfig.id || vlanConfig.vlan;

  // New unified: capsman.vlan.address, Legacy: cap.capsmanVlan.address, capsmanAddress
  const staticIp = vlanConfig.address || config.capsmanAddress;
  const network = vlanConfig.network;

  // Skip if no VLAN config or static IP specified
  if (!vlanId || !staticIp) {
    return null;
  }

  console.log('\n=== Configuring CAPsMAN VLAN ===');
  console.log(`VLAN ID: ${vlanId}`);
  console.log(`Static IP: ${staticIp}`);

  // Extract prefix from network (e.g., "10.252.50.0/24" -> "24")
  let prefix = '24';
  if (network && network.includes('/')) {
    prefix = network.split('/')[1];
  }

  // Step 1: Remove existing CAPsMAN VLAN interface if present
  try {
    await mt.exec('/interface vlan remove [find name=capsman-vlan]');
    console.log('✓ Removed existing capsman-vlan (if any)');
  } catch (e) {
    // Ignore - interface may not exist
  }

  // Step 2: Remove existing firewall rules for CAPsMAN VLAN
  try {
    await mt.exec('/ip firewall filter remove [find comment~"CAPsMAN"]');
    console.log('✓ Removed existing CAPsMAN firewall rules (if any)');
  } catch (e) {
    // Ignore - rules may not exist
  }

  // Step 3: Create VLAN interface on bridge
  try {
    await mt.exec(`/interface vlan add name=capsman-vlan vlan-id=${vlanId} interface=bridge`);
    console.log(`✓ Created VLAN interface: capsman-vlan (VLAN ${vlanId})`);
  } catch (e) {
    console.log(`✗ Failed to create VLAN interface: ${e.message}`);
    return null;
  }

  // Step 4: Assign static IP
  try {
    await mt.exec(`/ip address add address=${staticIp}/${prefix} interface=capsman-vlan`);
    console.log(`✓ Assigned IP address: ${staticIp}/${prefix}`);
  } catch (e) {
    console.log(`✗ Failed to assign IP: ${e.message}`);
    return null;
  }

  // Step 5: Add firewall rules - allow CAPWAP, block everything else
  // Place rules at the beginning of the filter chain
  try {
    // Allow CAPWAP traffic (UDP 5246-5247)
    await mt.exec(
      '/ip firewall filter add chain=input protocol=udp dst-port=5246-5247 ' +
      'in-interface=capsman-vlan action=accept place-before=0 comment="CAPsMAN CAPWAP - allow"'
    );
    console.log('✓ Added firewall rule: allow CAPWAP (UDP 5246-5247)');

    // Block all other traffic on CAPsMAN VLAN
    await mt.exec(
      '/ip firewall filter add chain=input in-interface=capsman-vlan ' +
      'action=drop place-before=1 comment="CAPsMAN VLAN - block admin"'
    );
    console.log('✓ Added firewall rule: block other traffic (admin protection)');
  } catch (e) {
    console.log(`⚠️  Firewall rule error: ${e.message}`);
  }

  console.log(`✓ CAPsMAN VLAN configured successfully`);
  return staticIp;
}

module.exports = {
  execIdempotent,
  execWithWarning,
  setDeviceIdentity,
  detectWifiPackage,
  ensureBridgeInfrastructure,
  configureIgmpSnooping,
  ensureWifiInterfacesInBridge,
  configureLacpBond,
  configureManagementInterfaces,
  configureDisabledInterfaces,
  enableDhcpClient,
  configureSyslog,
  configureCapsmanVlan
};
