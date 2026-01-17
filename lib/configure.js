/**
 * Main MikroTik configuration entry point
 * Dispatches to controller/cap/standalone configuration
 */

const { MikroTikSSH } = require('./ssh-client');
const { CHANNEL_FREQ_24GHZ, CHANNEL_FREQ_5GHZ } = require('./constants');
const { escapeMikroTik, getWifiPath } = require('./utils');
const {
  setDeviceIdentity,
  ensureBridgeInfrastructure,
  configureLacpBond,
  configureSyslog
} = require('./infrastructure');
const { configureController, configureCap } = require('./capsman');

/**
 * Main configuration function - dispatches based on role
 * @param {Object} config - Device configuration
 * @returns {Promise<boolean>} Success status
 */
async function configureMikroTik(config = {}) {
  // Detect role and delegate to appropriate function
  const role = config.role || 'standalone';

  if (role === 'controller') {
    return configureController(config);
  } else if (role === 'cap') {
    return configureCap(config);
  }

  // Default: standalone mode (existing behavior)
  const mt = new MikroTikSSH(
    config.host || '192.168.88.1',
    config.username || 'admin',
    config.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('MikroTik WiFi Configuration');
    console.log('Band-based SSID assignment');
    console.log('========================================\n');

    const ssids = config.ssids || [];

    if (ssids.length === 0) {
      console.log('⚠️  No SSIDs configured');
      await mt.close();
      return false;
    }

    // Step 0: Set device identity based on hostname (if FQDN provided)
    await setDeviceIdentity(mt, config);

    // Step 0.5-1: Ensure bridge exists and disable VLAN filtering
    await ensureBridgeInfrastructure(mt);

    // Step 2: Configure Bridge Ports FIRST (before removing default IP)
    // This ensures management access is established before we remove the default config
    console.log('\n=== Step 2: Configuring Bridge Ports (Management Access) ===');

    // Handle management interfaces (can be simple interfaces or bonds)
    const mgmtInterfaces = config.managementInterfaces || ['ether1'];

    // Process management interfaces
    for (const mgmtInterface of mgmtInterfaces) {
      if (typeof mgmtInterface === 'string') {
        // Simple interface - add directly to bridge
        try {
          await mt.exec(`/interface bridge port add bridge=bridge interface=${mgmtInterface}`);
          console.log(`✓ Added ${mgmtInterface} to bridge`);
        } catch (e) {
          if (e.message.includes('already have interface')) {
            console.log(`✓ ${mgmtInterface} already in bridge`);
          } else {
            throw e;
          }
        }
      } else if (mgmtInterface.bond && Array.isArray(mgmtInterface.bond)) {
        // LACP bond configuration
        const bondName = 'bond1';  // Default bond name
        const bondMembers = mgmtInterface.bond;

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
      }
    }

    // Disable unused interfaces for security
    const disabledInterfaces = config.disabledInterfaces || [];
    if (disabledInterfaces.length > 0) {
      console.log('\n=== Disabling Unused Interfaces ===');
      for (const iface of disabledInterfaces) {
        try {
          await mt.exec(`/interface ethernet set [find default-name=${iface}] disabled=yes`);
          console.log(`✓ Disabled ${iface}`);
        } catch (e) {
          console.log(`⚠️  Could not disable ${iface}: ${e.message}`);
        }
      }
    }

    // Step 2.5: Ensure DHCP client is configured on bridge BEFORE removing default IP
    console.log('\n=== Step 2.5: Establishing Management via DHCP ===');

    // First, ensure DHCP client exists on bridge
    try {
      await mt.exec('/ip dhcp-client add interface=bridge disabled=no');
      console.log('✓ Added DHCP client on bridge');
    } catch (e) {
      if (e.message.includes('already have')) {
        // Enable existing DHCP client
        try {
          await mt.exec('/ip dhcp-client enable [find interface=bridge]');
          console.log('✓ Enabled existing DHCP client on bridge');
        } catch (enableErr) {
          console.log('⚠️  DHCP client already enabled');
        }
      } else {
        console.log('⚠️  Could not add DHCP client: ' + e.message);
      }
    }

    // Give DHCP client time to obtain an IP
    console.log('⏳ Waiting for DHCP client to obtain IP address...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check if DHCP client has an IP address
    let hasManagementIP = false;
    let connectedViaDefaultIP = false;

    try {
      const dhcpStatus = await mt.exec('/ip dhcp-client print detail where interface=bridge');
      if (dhcpStatus.includes('status=bound') || dhcpStatus.includes('address=')) {
        console.log('✓ DHCP client has obtained an IP address');
        hasManagementIP = true;
      } else {
        console.log('⚠️  DHCP client has not obtained an IP yet');
      }

      // Check if we're connected via the default IP
      if (config.host === '192.168.88.1') {
        connectedViaDefaultIP = true;
        console.log('⚠️  Connected via default IP 192.168.88.1');
      }
    } catch (e) {
      console.log('⚠️  Could not verify DHCP status: ' + e.message);
    }

    // Step 3: Configure as Managed WAP (Disable Router Functions)
    console.log('\n=== Step 3: Configuring as Managed WAP ===');

    // Only proceed with removing default IP if we have alternative management access
    // OR if we're not connected via the default IP
    const safeToRemoveDefaultIP = hasManagementIP || !connectedViaDefaultIP;

    // Disable DHCP server (WAP should not provide DHCP)
    try {
      await mt.exec('/ip dhcp-server remove [find]');
      console.log('✓ Removed all DHCP servers');
    } catch (e) {
      if (e.message.includes('no such item')) {
        console.log('✓ No DHCP servers to remove');
      } else {
        console.log('⚠️  Could not remove DHCP servers: ' + e.message);
      }
    }

    // Remove default IP address (192.168.88.1/24) - but only if safe to do so
    if (safeToRemoveDefaultIP) {
      try {
        await mt.exec('/ip address remove [find address="192.168.88.1/24"]');
        console.log('✓ Removed default IP address 192.168.88.1/24');
      } catch (e) {
        if (e.message.includes('no such item')) {
          console.log('✓ Default IP already removed');
        } else {
          console.log('⚠️  Could not remove default IP: ' + e.message);
        }
      }

      // Remove any other static IP addresses on bridge
      try {
        await mt.exec('/ip address remove [find interface=bridge dynamic=no]');
        console.log('✓ Removed static IP addresses from bridge');
      } catch (e) {
        if (e.message.includes('no such item')) {
          console.log('✓ No static IPs to remove from bridge');
        } else {
          console.log('⚠️  Some IPs may remain: ' + e.message);
        }
      }
    } else {
      console.log('⚠️  Keeping default IP 192.168.88.1 - no alternative management access yet');
      console.log('    Please reconnect via DHCP-assigned IP after configuration completes');
    }

    // Disable DNS server for remote requests
    try {
      await mt.exec('/ip dns set allow-remote-requests=no');
      console.log('✓ Disabled DNS server for remote requests');
    } catch (e) {
      console.log('⚠️  Could not disable DNS server: ' + e.message);

      // Check if we lost connection after removing default IP
      if ((e.message === 'Not connected' || e.message === 'Command timeout') && connectedViaDefaultIP) {
        console.log('\n========================================');
        console.log('⚠️  Lost connection after removing default IP');
        console.log('========================================');
        console.log('This is EXPECTED when configuring fresh devices via 192.168.88.1');
        console.log('\nNext steps:');
        console.log('1. The device should now be accessible via DHCP on the management interfaces');
        console.log('2. Check your DHCP server logs for the new IP address');
        console.log('3. Reconnect to the new IP and re-run this script to complete WiFi configuration');
        console.log('\nThe device is partially configured:');
        console.log('✓ Bridge and management interfaces configured');
        console.log('✓ DHCP client enabled on bridge');
        console.log('✓ Default router functions disabled');
        console.log('✗ WiFi configuration incomplete - re-run script to complete');
        await mt.close();
        return false;
      }
    }

    // Remove firewall NAT rules (WAP doesn't need NAT)
    try {
      await mt.exec('/ip firewall nat remove [find]');
      console.log('✓ Removed all NAT rules');
    } catch (e) {
      if (e.message.includes('no such item')) {
        console.log('✓ No NAT rules to remove');
      } else {
        console.log('⚠️  Could not remove NAT rules: ' + e.message);

        // Check for connection loss
        if ((e.message === 'Not connected' || e.message === 'Command timeout') && connectedViaDefaultIP) {
          console.log('\n⚠️  Connection lost - device should be accessible via new management IP');
          console.log('    Please reconnect and re-run to complete configuration');
          await mt.close();
          return false;
        }
      }
    }

    // Step 4: Initialize WiFi Interfaces (for fresh devices)
    console.log('\n=== Step 4: Initializing WiFi Interfaces ===');

    // Detect which WiFi package is in use by checking installed packages
    // This is reliable because wifi-qcom devices respond to both /interface/wifi and /interface/wifiwave2
    // so we must check the actual package name, not command availability
    let wifiPackage = 'unknown';
    const MAX_RETRIES = 3;

    for (let retry = 0; retry < MAX_RETRIES && wifiPackage === 'unknown'; retry++) {
      try {
        const packages = await mt.exec('/system package print terse where name~"wifi"');

        if (packages.includes('wifiwave2')) {
          wifiPackage = 'wifiwave2';
          console.log('✓ Using WiFiWave2 package (newer chipset)');
        } else if (packages.includes('wifi-qcom')) {
          wifiPackage = 'wifi-qcom';
          console.log('✓ Using WiFi-QCOM package (Qualcomm chipset)');
        } else if (packages.includes('wifi-ax') || packages.includes('wifi ')) {
          wifiPackage = 'wifi-qcom';  // Same command path as wifi-qcom
          console.log('✓ Using WiFi package (modern chipset)');
        } else {
          // Check for legacy wireless package (very old devices)
          try {
            await mt.exec('/interface/wireless print count-only');
            wifiPackage = 'wireless';
            console.log('✓ Using Wireless package (legacy)');
          } catch (wirelessErr) {
            // No WiFi package found yet
            if (retry < MAX_RETRIES - 1) {
              console.log(`⚠️  WiFi package not detected, retrying... (${MAX_RETRIES - retry - 1} left)`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        }
      } catch (e) {
        // Package query failed - device may still be initializing
        if (retry < MAX_RETRIES - 1) {
          console.log(`⚠️  WiFi subsystem not ready, retrying... (${MAX_RETRIES - retry - 1} left)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    if (wifiPackage === 'unknown') {
      console.log('⚠️  Could not determine WiFi package type after 3 attempts');
      console.log('    Device may need more time to initialize WiFi subsystem');
      console.log('    Please re-run the script in a few moments');
    }

    // Store the WiFi command prefix based on package
    const wifiCmd = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2' : '/interface/wifi';

    // Check for specific interfaces based on package type
    if (wifiPackage === 'wifiwave2') {
      try {
        // WiFiWave2 typically uses wifi1/wifi2 naming
        const wifi1Check = await mt.exec(`${wifiCmd} print terse where name=wifi1`);
        if (!wifi1Check || !wifi1Check.trim()) {
          console.log('⚠️  wifi1 (2.4GHz) interface not found - checking alternative names');
          // Try to find any 2.4GHz interface
          const band2Check = await mt.exec(`${wifiCmd} print terse where configuration.band~"2ghz"`);
          if (band2Check && band2Check.trim()) {
            console.log('✓ Found 2.4GHz interface');
          }
        } else {
          console.log('✓ wifi1 (2.4GHz) interface found');
        }

        const wifi2Check = await mt.exec(`${wifiCmd} print terse where name=wifi2`);
        if (!wifi2Check || !wifi2Check.trim()) {
          console.log('⚠️  wifi2 (5GHz) interface not found - checking alternative names');
          // Try to find any 5GHz interface
          const band5Check = await mt.exec(`${wifiCmd} print terse where configuration.band~"5ghz"`);
          if (band5Check && band5Check.trim()) {
            console.log('✓ Found 5GHz interface');
          }
        } else {
          console.log('✓ wifi2 (5GHz) interface found');
        }
      } catch (e) {
        console.log('⚠️  Could not verify WiFiWave2 interfaces: ' + e.message);
      }
    } else if (wifiPackage === 'wifi-qcom') {
      try {
        // WiFi-QCOM uses wifi1/wifi2 naming
        const wifi1Check = await mt.exec(`${wifiCmd} print terse where default-name=wifi1`);
        if (!wifi1Check || !wifi1Check.trim()) {
          console.log('⚠️  2.4GHz WiFi interface not found');
        } else {
          console.log('✓ wifi1 (2.4GHz) interface found');
        }

        const wifi2Check = await mt.exec(`${wifiCmd} print terse where default-name=wifi2`);
        if (!wifi2Check || !wifi2Check.trim()) {
          console.log('⚠️  5GHz WiFi interface not found');
        } else {
          console.log('✓ wifi2 (5GHz) interface found');
        }
      } catch (e) {
        console.log('⚠️  Could not verify WiFi-QCOM interfaces: ' + e.message);
      }
    } else if (wifiPackage === 'wireless') {
      console.log('⚠️  Legacy wireless interfaces detected - manual migration needed');
    }

    // Step 4.5: Evacuate WiFi clients before reconfiguration
    // This gives clients a head start to find another AP before we tear down interfaces
    if (wifiPackage !== 'unknown' && wifiPackage !== 'wireless') {
      console.log('\n=== Step 4.5: Evacuating WiFi Clients ===');
      try {
        const regTablePath = wifiPackage === 'wifiwave2'
          ? '/interface/wifiwave2/registration-table'
          : '/interface/wifi/registration-table';

        // Check if there are any connected clients
        const clients = await mt.exec(`${regTablePath} print count-only`);
        const clientCount = parseInt(clients.trim(), 10) || 0;

        if (clientCount > 0) {
          console.log(`Found ${clientCount} connected client(s), disconnecting...`);
          await mt.exec(`${regTablePath} remove [find]`);
          console.log('✓ Disconnected all WiFi clients (they will reconnect to other APs)');
          // Brief pause to allow clients to start reconnecting elsewhere
          await new Promise(resolve => setTimeout(resolve, 2000));
          console.log('✓ Waited 2s for clients to find other APs');
        } else {
          console.log('✓ No WiFi clients connected');
        }
      } catch (e) {
        // Non-fatal - proceed with reconfiguration even if evacuation fails
        console.log(`⚠️  Could not evacuate clients: ${e.message}`);
      }
    }

    // Step 5: Clean up old virtual WiFi interfaces and datapaths
    console.log('\n=== Step 5: Cleaning Up Old Configurations ===');

    // Skip cleanup if package type is unknown
    if (wifiPackage === 'unknown' || wifiPackage === 'wireless') {
      console.log('⚠️  Skipping cleanup - WiFi package not supported');
    } else {
      // First remove datapaths (to avoid "in use" errors when removing interfaces)
      try {
        const datapathCmd = wifiPackage === 'wifiwave2'
          ? '/interface/wifiwave2/datapath print terse where name~"wifi"'
          : '/interface/wifi/datapath print terse where name~"wifi"';

        const datapaths = await mt.exec(datapathCmd);
        if (datapaths && datapaths.trim()) {
          const removeCmd = wifiPackage === 'wifiwave2'
            ? '/interface/wifiwave2/datapath remove [find name~"wifi"]'
            : '/interface/wifi/datapath remove [find name~"wifi"]';
          await mt.exec(removeCmd);
          console.log('✓ Removed old WiFi datapaths');
        } else {
          console.log('✓ No datapaths to remove');
        }
      } catch (e) {
        // Only ignore "no such item" errors
        if (e.message.includes('no such') || e.message.includes('not found')) {
          console.log('✓ No datapaths to remove');
        } else {
          console.log(`⚠️  Warning: Could not remove datapaths: ${e.message}`);
        }
      }

      // Then remove virtual WiFi interfaces
      try {
        const printCmd = wifiPackage === 'wifiwave2'
          ? '/interface/wifiwave2 print terse where master-interface'
          : '/interface/wifi print terse where master-interface';

        const virtualInterfaces = await mt.exec(printCmd);
        if (virtualInterfaces && virtualInterfaces.trim()) {
          const removeCmd = wifiPackage === 'wifiwave2'
            ? '/interface/wifiwave2 remove [find master-interface]'
            : '/interface/wifi remove [find master-interface]';
          await mt.exec(removeCmd);
          console.log('✓ Removed old virtual WiFi interfaces');
        } else {
          console.log('✓ No virtual interfaces to remove');
        }
      } catch (e) {
        // Only ignore "no such item" errors
        if (e.message.includes('no such') || e.message.includes('not found')) {
          console.log('✓ No virtual interfaces to remove');
        } else {
          console.log(`⚠️  Warning: Could not remove virtual interfaces: ${e.message}`);
        }
      }

      // Reset master interface names to defaults (ensures idempotency if manually renamed)
      console.log('\n--- Resetting Interface Names to Defaults ---');
      for (const defaultName of ['wifi1', 'wifi2']) {
        try {
          await mt.exec(`${wifiCmd} set [find default-name=${defaultName}] name=${defaultName}`);
          console.log(`✓ Reset ${defaultName} to default name`);
        } catch (e) {
          // Interface might not exist on single-band devices
          if (!e.message.includes('no such item') && !e.message.includes('not found')) {
            console.log(`⚠️  Could not reset ${defaultName}: ${e.message}`);
          }
        }
      }
    }

    // Step 6: Configure WiFi Optimization Settings (Channel, Power, Roaming)
    console.log('\n=== Step 6: Configuring WiFi Optimization Settings ===');

    const wifiConfig = config.wifi || {};
    const wifiPath = getWifiPath(wifiPackage);

    // Detect which interface is which band (varies by device model)
    // e.g., wAP ax: wifi1=2.4GHz, wifi2=5GHz
    //       cAP ax: wifi1=5GHz, wifi2=2.4GHz
    let interface24 = 'wifi1';
    let interface5 = 'wifi2';
    try {
      // First check board name - most reliable way to detect radio layout
      const resource = await mt.exec('/system resource print');
      const boardMatch = resource.match(/board-name:\s*([^\n]+)/);
      const boardName = boardMatch ? boardMatch[1].trim().toLowerCase() : '';

      // Known devices with swapped radios (wifi1=5GHz, wifi2=2.4GHz)
      const swappedRadioDevices = ['cap ax', 'cap ac'];

      if (swappedRadioDevices.some(d => boardName.includes(d))) {
        interface24 = 'wifi2';
        interface5 = 'wifi1';
        console.log(`ℹ️  ${boardMatch[1].trim()}: Swapped radio layout (wifi1=5GHz, wifi2=2.4GHz)`);
      } else {
        console.log(`ℹ️  ${boardMatch ? boardMatch[1].trim() : 'Unknown device'}: Standard radio layout (wifi1=2.4GHz, wifi2=5GHz)`);
      }
    } catch (e) {
      console.log('⚠️  Could not detect board, assuming standard: wifi1=2.4GHz, wifi2=5GHz');
    }

    // Create dynamic band-to-interface mapping based on detected layout
    const bandToInterface = {
      '2.4GHz': interface24,
      '5GHz': interface5
    };

    // Configure 2.4GHz band settings
    if (wifiConfig['2.4GHz']) {
      const config24 = wifiConfig['2.4GHz'];
      console.log(`\nConfiguring 2.4GHz band (${interface24}):`);

      const commands = [];

      // Ensure correct band is set
      commands.push('channel.band=2ghz-ax');

      // Channel configuration
      if (config24.channel !== undefined) {
        const freq = CHANNEL_FREQ_24GHZ[config24.channel];
        if (freq) {
          commands.push(`channel.frequency=${freq}`);
          console.log(`  ✓ Channel ${config24.channel} (${freq} MHz)`);
        }
      } else if (config24.frequency !== undefined) {
        commands.push(`channel.frequency=${config24.frequency}`);
        console.log(`  ✓ Frequency ${config24.frequency} MHz`);
      }

      // TX Power
      if (config24.txPower !== undefined) {
        commands.push(`configuration.tx-power=${config24.txPower}`);
        console.log(`  ✓ TX Power ${config24.txPower} dBm`);
      }

      // Country (per-band or wifi-level)
      const country24 = config24.country || wifiConfig.country;
      if (country24) {
        commands.push(`configuration.country="${country24}"`);
        console.log(`  ✓ Country ${country24}`);
      }

      // Channel Width
      if (config24.width !== undefined) {
        commands.push(`channel.width=${config24.width}`);
        console.log(`  ✓ Channel Width ${config24.width}`);
      }

      if (commands.length > 0) {
        try {
          await mt.exec(`${wifiPath} set ${interface24} ${commands.join(' ')}`);
          console.log('  ✓ Applied 2.4GHz band settings');
        } catch (e) {
          console.log(`  ⚠️  Failed to apply 2.4GHz settings: ${e.message}`);
        }
      }
    }

    // Configure 5GHz band settings
    if (wifiConfig['5GHz']) {
      const config5 = wifiConfig['5GHz'];
      console.log(`\nConfiguring 5GHz band (${interface5}):`);

      const commands = [];

      // Ensure correct band is set (prevents issues if GUI changed it)
      commands.push('channel.band=5ghz-ax');

      // Channel configuration
      if (config5.channel !== undefined) {
        const freq = CHANNEL_FREQ_5GHZ[config5.channel];
        if (freq) {
          commands.push(`channel.frequency=${freq}`);
          console.log(`  ✓ Channel ${config5.channel} (${freq} MHz)`);
        }
      } else if (config5.frequency !== undefined) {
        commands.push(`channel.frequency=${config5.frequency}`);
        console.log(`  ✓ Frequency ${config5.frequency} MHz`);
      }

      // TX Power
      if (config5.txPower !== undefined) {
        commands.push(`configuration.tx-power=${config5.txPower}`);
        console.log(`  ✓ TX Power ${config5.txPower} dBm`);
      }

      // Country (per-band or wifi-level)
      const country5 = config5.country || wifiConfig.country;
      if (country5) {
        commands.push(`configuration.country="${country5}"`);
        console.log(`  ✓ Country ${country5}`);
      }

      // Channel Width
      if (config5.width !== undefined) {
        commands.push(`channel.width=${config5.width}`);
        console.log(`  ✓ Channel Width ${config5.width}`);
      }

      if (commands.length > 0) {
        try {
          await mt.exec(`${wifiPath} set ${interface5} ${commands.join(' ')}`);
          console.log('  ✓ Applied 5GHz band settings');
        } catch (e) {
          console.log(`  ⚠️  Failed to apply 5GHz settings: ${e.message}`);
        }
      }
    }

    // Step 7: Process each SSID
    console.log('\n=== Step 7: Configuring SSIDs ===');

    // Track which interfaces have been used for each band
    const bandUsage = {
      '2.4GHz': 0,
      '5GHz': 0
    };

    for (const ssidConfig of ssids) {
      const { ssid, passphrase, vlan, bands } = ssidConfig;

      if (!ssid || !passphrase || !vlan || !bands || bands.length === 0) {
        console.log(`⚠️  Skipping incomplete SSID configuration: ${ssid || 'unnamed'}`);
        continue;
      }

      console.log(`\nConfiguring SSID: ${ssid}`);
      console.log(`  VLAN: ${vlan}`);
      console.log(`  Bands: ${bands.join(', ')}`);
      console.log(`  Password: ${passphrase}`);

      // Determine authentication type based on per-SSID roaming configuration
      // wifi-qcom uses security.ft=yes, wifiwave2 uses ft-psk auth type
      const useFastTransition = ssidConfig.roaming?.fastTransition === true;
      let authTypes;
      let ftParam;
      if (wifiPackage === 'wifi-qcom') {
        // wifi-qcom doesn't support ft-psk auth type, use security.ft=yes instead
        authTypes = 'wpa2-psk';
        ftParam = useFastTransition ? 'security.ft=yes' : 'security.ft=no';
      } else {
        // wifiwave2 uses ft-psk auth type
        authTypes = useFastTransition ? 'ft-psk,wpa2-psk' : 'wpa2-psk';
        ftParam = '';
      }
      if (useFastTransition) {
        console.log(`  802.11r: enabled`);
      }

      // Configure each band this SSID should broadcast on
      for (const band of bands) {
        const masterInterface = bandToInterface[band];

        if (!masterInterface) {
          console.log(`  ⚠️  Unknown band: ${band}, skipping`);
          continue;
        }

        // Determine which interface to use (master or virtual)
        let wifiInterface;
        let isVirtual = false;

        if (bandUsage[band] === 0) {
          // First SSID for this band - use master interface
          wifiInterface = masterInterface;
        } else {
          // Additional SSID for this band - create virtual interface
          wifiInterface = `${masterInterface}-ssid${bandUsage[band] + 1}`;
          isVirtual = true;
        }

        bandUsage[band]++;

        try {
          // Create virtual interface if needed
          if (isVirtual) {
            try {
              await mt.exec(
                `${wifiPath} add ` +
                `master-interface=${masterInterface} ` +
                `name="${wifiInterface}"`
              );
              console.log(`  ✓ Created virtual interface ${wifiInterface}`);
              // Small delay to ensure interface is fully registered
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (e) {
              if (e.message.includes('already have') || e.message.includes('exists')) {
                console.log(`  ✓ Virtual interface ${wifiInterface} already exists`);
              } else {
                throw e;
              }
            }
          }

          // Create or update datapath for VLAN tagging
          const datapathName = `${wifiInterface}-vlan${vlan}`;

          // Try to add datapath, ignore if it already exists
          try {
            await mt.exec(
              `${getWifiPath(wifiPackage, 'datapath')} add ` +
              `name="${datapathName}" ` +
              `vlan-id=${vlan} ` +
              `bridge=bridge`
            );
            console.log(`  ✓ Created datapath ${datapathName} for VLAN ${vlan}`);
          } catch (e) {
            if (e.message.includes('already have') || e.message.includes('exists')) {
              // Update existing datapath
              await mt.exec(
                `${getWifiPath(wifiPackage, 'datapath')} set [find name="${datapathName}"] ` +
                `vlan-id=${vlan} ` +
                `bridge=bridge`
              );
              console.log(`  ✓ Updated datapath ${datapathName} for VLAN ${vlan}`);
            } else {
              throw e;
            }
          }

          // Configure WiFi interface with SSID, security, and datapath
          // Use direct interface name - [find name=...] doesn't work reliably for newly created virtual interfaces
          // Escape special characters in passphrase for MikroTik
          const escapedPassphrase = escapeMikroTik(passphrase);
          const escapedSsid = escapeMikroTik(ssid);

          const setCmd =
            `${wifiPath} set ${wifiInterface} ` +
            `configuration.ssid="${escapedSsid}" ` +
            `datapath.bridge=bridge datapath.vlan-id=${vlan} ` +
            `security.authentication-types=${authTypes} ` +
            (ftParam ? `${ftParam} ` : '') +
            `security.passphrase="${escapedPassphrase}" ` +
            `disabled=no`;

          const setResult = await mt.exec(setCmd);
          if (setResult.trim()) {
            console.log(`    Set command output: ${setResult.trim()}`);
          }

          // Verify configuration was applied by checking if SSID appears in interface output
          const verifyResult = await mt.exec(`${wifiPath} print terse where name="${wifiInterface}"`);
          if (!verifyResult.includes(ssid)) {
            console.log(`  ⚠️  SSID "${ssid}" may not have been applied to ${wifiInterface}`);
            // Print abbreviated interface state for debugging
            const truncated = verifyResult.trim().substring(0, 200);
            if (truncated) {
              console.log(`    Interface state: ${truncated}...`);
            }
          }

          console.log(`  ✓ ${wifiInterface} (${band}) configured with VLAN ${vlan} tagging`);
        } catch (e) {
          console.log(`  ✗ Failed to configure ${wifiInterface}: ${e.message}`);

          // Check if we lost connection
          if (e.message === 'Not connected' || e.message === 'Command timeout') {
            console.log('\n⚠️  Lost connection to device - this is expected when configuring fresh devices');
            console.log('    The device should now be accessible via DHCP-assigned IP on the management interfaces');
            console.log('    Please reconnect and re-run the script to complete configuration');
            await mt.close();
            return false;
          }
        }
      }
    }

    // Step 7.5: Disable master interfaces for bands with no SSIDs
    console.log('\n=== Disabling Unused Bands ===');

    for (const [band, count] of Object.entries(bandUsage)) {
      if (count === 0) {
        const masterInterface = bandToInterface[band];
        try {
          await mt.exec(`${wifiPath} set ${masterInterface} disabled=yes`);
          console.log(`✓ Disabled ${masterInterface} (${band}) - no SSIDs configured`);
        } catch (e) {
          console.log(`⚠️  Could not disable ${masterInterface}: ${e.message}`);
        }
      }
    }

    // Step 8: Configure Syslog (if specified)
    await configureSyslog(mt, config);

    console.log('\n========================================');
    console.log('✓✓✓ Configuration Complete! ✓✓✓');
    console.log('========================================');

    // Format management interfaces for display
    const mgmtDisplay = mgmtInterfaces.map(iface => {
      if (typeof iface === 'string') {
        return iface;
      } else if (iface.bond) {
        return `bond1 (${iface.bond.join('+')})`;
      }
      return 'unknown';
    });

    console.log(`\nManagement Access: ${mgmtDisplay.join(', ')}`);

    if (disabledInterfaces.length > 0) {
      console.log(`Disabled Interfaces: ${disabledInterfaces.join(', ')}`);
    }

    console.log('\nConfigured SSIDs:');

    // Summary of what was configured
    for (const ssidConfig of ssids) {
      const { ssid, bands, vlan } = ssidConfig;
      if (ssid && bands) {
        console.log(`  ✓ ${ssid}`);
        console.log(`    Bands: ${bands.join(', ')}`);
        console.log(`    VLAN: ${vlan}`);
      }
    }

    console.log('\n✓ Device remains accessible');
    console.log('✓ No lockout risk - VLAN filtering disabled');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

module.exports = { configureMikroTik };
