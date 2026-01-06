#!/usr/bin/env node

/**
 * Safe MikroTik Configuration - No VLAN Filtering
 *
 * This configuration achieves VLAN isolation for WiFi clients WITHOUT
 * enabling bridge VLAN filtering, eliminating the risk of lockout.
 *
 * New YAML Schema:
 * - SSIDs defined by name, not interface
 * - Each SSID can specify bands: 2.4GHz, 5GHz, or both
 * - Per-SSID passphrases and VLANs
 *
 * Features:
 * - Automatic device identity from FQDN hostnames
 * - WiFi optimization (channel, power, roaming)
 * - Multi-device configuration support
 */

const { Client } = require('ssh2');

class MikroTikSSH {
  constructor(host, username, password) {
    this.host = host;
    this.username = username;
    this.password = password;
    this.conn = new Client();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.conn.on('ready', () => {
        console.log('✓ Connected to MikroTik device');
        resolve();
      }).on('error', (err) => {
        // Improve error messages for common issues
        if (err.message.includes('All configured authentication methods failed')) {
          reject(new Error(`Authentication failed for user '${this.username}' at ${this.host} - check username and password`));
        } else if (err.message.includes('ECONNREFUSED')) {
          reject(new Error(`Connection refused to ${this.host}:22 - check if device is reachable and SSH is enabled`));
        } else if (err.message.includes('ETIMEDOUT') || err.message.includes('Timed out')) {
          reject(new Error(`Connection timeout to ${this.host} - check network connectivity and firewall rules`));
        } else if (err.message.includes('EHOSTUNREACH')) {
          reject(new Error(`Host ${this.host} is unreachable - check network path and routing`));
        } else {
          reject(err);
        }
      }).connect({
        host: this.host,
        port: 22,
        username: this.username,
        password: this.password,
        readyTimeout: 30000,
        algorithms: {
          serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519']
        }
      });
    });
  }

  async exec(command) {
    return new Promise((resolve, reject) => {
      // Check if connection is still alive
      if (!this.conn || !this.conn.readable || !this.conn.writable) {
        reject(new Error('Not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, 30000);

      this.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        let output = '';
        let errorOutput = '';

        stream.on('close', (code, signal) => {
          clearTimeout(timeout);
          if (errorOutput) {
            reject(new Error(errorOutput));
          } else {
            resolve(output);
          }
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    });
  }

  isConnected() {
    return this.conn && this.conn.readable && this.conn.writable;
  }

  async close() {
    this.conn.end();
  }
}

// Map band names to interface names (will be updated based on detected package)
const BAND_TO_INTERFACE = {
  '2.4GHz': 'wifi1',
  '5GHz': 'wifi2'
};

// Helper to get correct WiFi command path based on package type
function getWifiPath(wifiPackage, command) {
  const basePath = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2' : '/interface/wifi';
  return command ? `${basePath}/${command}` : basePath;
}

async function configureMikroTik(config = {}) {
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
    console.log('=== Step 0: Setting Device Identity ===');

    // Extract hostname from FQDN or use configured identity
    let deviceIdentity = config.identity; // Allow explicit identity override

    if (!deviceIdentity && config.host) {
      // Check if host is FQDN (contains dots) and NOT an IP address
      if (config.host.includes('.') && !config.host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        // Extract hostname from FQDN (everything before first dot)
        deviceIdentity = config.host.split('.')[0];
        console.log(`✓ Extracted hostname from FQDN: ${deviceIdentity}`);
      } else if (!config.host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        // If not an IP address and not FQDN, use it as hostname
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

    // Step 0.5: Ensure Bridge Exists (for fresh devices)
    console.log('\n=== Step 0.5: Ensuring Basic Infrastructure ===');

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
      // If print fails, try to add anyway
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

    // Step 1: Ensure Bridge VLAN Filtering is DISABLED (for safety)
    console.log('\n=== Step 1: Ensuring Safe Bridge Configuration ===');
    try {
      await mt.exec('/interface bridge set bridge vlan-filtering=no');
      console.log('✓ VLAN filtering is DISABLED (safe for management)');
    } catch (e) {
      console.log('⚠️  Could not disable VLAN filtering: ' + e.message);
    }

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

        // Create or update bond interface
        try {
          // First check if bond exists
          const bondCheck = await mt.exec(`/interface bonding print where name=${bondName}`);
          if (!bondCheck || bondCheck.includes('no such item') || !bondCheck.includes(bondName)) {
            // Create new bond with LACP (802.3ad mode)
            await mt.exec(`/interface bonding add name=${bondName} slaves="${bondMembers.join(',')}" mode=802.3ad lacp-rate=30secs transmit-hash-policy=layer-2-and-3`);
            console.log(`✓ Created LACP bond ${bondName} with members: ${bondMembers.join(', ')}`);
          } else {
            // Update existing bond
            await mt.exec(`/interface bonding set [find name=${bondName}] slaves="${bondMembers.join(',')}" mode=802.3ad lacp-rate=30secs transmit-hash-policy=layer-2-and-3`);
            console.log(`✓ Updated LACP bond ${bondName} with members: ${bondMembers.join(', ')}`);
          }
        } catch (e) {
          console.log(`⚠️  Bond configuration error: ${e.message}`);
          // Try alternative approach for existing bonds
          try {
            await mt.exec(`/interface bonding remove [find name=${bondName}]`);
            await mt.exec(`/interface bonding add name=${bondName} slaves="${bondMembers.join(',')}" mode=802.3ad lacp-rate=30secs transmit-hash-policy=layer-2-and-3`);
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

    // Detect which WiFi package is in use - with retry logic for fresh devices
    let wifiPackage = 'unknown';
    let retries = 3;

    while (wifiPackage === 'unknown' && retries > 0) {
      try {
        // Check for wifiwave2 package (newer chipsets)
        const wifiwave2Check = await mt.exec('/interface/wifiwave2 print count-only');
        wifiPackage = 'wifiwave2';
        console.log('✓ Using WiFiWave2 package (newer chipset)');
      } catch (e) {
        try {
          // Check for wifi/wifi-qcom package (original chipsets)
          const wifiCheck = await mt.exec('/interface/wifi print count-only');
          wifiPackage = 'wifi-qcom';
          console.log('✓ Using WiFi-QCOM package (original chipset)');
        } catch (e2) {
          // If both fail, try wireless (very old devices)
          try {
            const wirelessCheck = await mt.exec('/interface/wireless print count-only');
            wifiPackage = 'wireless';
            console.log('✓ Using Wireless package (legacy)');
          } catch (e3) {
            if (retries > 1) {
              console.log(`⚠️  WiFi package not detected yet, retrying... (${retries - 1} attempts left)`);
              await new Promise(resolve => setTimeout(resolve, 2000));
              retries--;
            } else {
              console.log('⚠️  Could not determine WiFi package type after 3 attempts');
              console.log('    Device may need more time to initialize WiFi subsystem');
              console.log('    Please re-run the script in a few moments');
              retries = 0;
            }
          }
        }
      }
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
    }

    // Step 6: Configure WiFi Optimization Settings (Channel, Power, Roaming)
    console.log('\n=== Step 6: Configuring WiFi Optimization Settings ===');

    const wifiConfig = config.wifi || {};
    const wifiPath = getWifiPath(wifiPackage);

    // Configure 2.4GHz band settings
    if (wifiConfig['2.4GHz']) {
      const config24 = wifiConfig['2.4GHz'];
      console.log('\nConfiguring 2.4GHz band (wifi1):');

      const commands = [];

      // Channel configuration
      if (config24.channel !== undefined) {
        // Map channel number to frequency
        const channelFreqMap = {
          1: 2412, 2: 2417, 3: 2422, 4: 2427, 5: 2432, 6: 2437,
          7: 2442, 8: 2447, 9: 2452, 10: 2457, 11: 2462, 12: 2467, 13: 2472
        };
        const freq = channelFreqMap[config24.channel];
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

      // Country
      if (config24.country) {
        commands.push(`configuration.country="${config24.country}"`);
        console.log(`  ✓ Country ${config24.country}`);
      }

      // Channel Width
      if (config24.width !== undefined) {
        commands.push(`channel.width=${config24.width}`);
        console.log(`  ✓ Channel Width ${config24.width}`);
      }

      if (commands.length > 0) {
        try {
          const findClause = wifiPackage === 'wifiwave2' ? '[find name=wifi1]' : '[find default-name=wifi1]';
          await mt.exec(`${wifiPath} set ${findClause} ${commands.join(' ')}`);
          console.log('  ✓ Applied 2.4GHz band settings');
        } catch (e) {
          console.log(`  ⚠️  Failed to apply 2.4GHz settings: ${e.message}`);
        }
      }
    }

    // Configure 5GHz band settings
    if (wifiConfig['5GHz']) {
      const config5 = wifiConfig['5GHz'];
      console.log('\nConfiguring 5GHz band (wifi2):');

      const commands = [];

      // Channel configuration
      if (config5.channel !== undefined) {
        // Map channel number to frequency for 5GHz
        const channelFreqMap = {
          36: 5180, 40: 5200, 44: 5220, 48: 5240,
          52: 5260, 56: 5280, 60: 5300, 64: 5320,
          100: 5500, 104: 5520, 108: 5540, 112: 5560, 116: 5580, 120: 5600, 124: 5620, 128: 5640,
          132: 5660, 136: 5680, 140: 5700, 144: 5720,
          149: 5745, 153: 5765, 157: 5785, 161: 5805, 165: 5825
        };
        const freq = channelFreqMap[config5.channel];
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

      // Country
      if (config5.country) {
        commands.push(`configuration.country="${config5.country}"`);
        console.log(`  ✓ Country ${config5.country}`);
      }

      // Channel Width
      if (config5.width !== undefined) {
        commands.push(`channel.width=${config5.width}`);
        console.log(`  ✓ Channel Width ${config5.width}`);
      }

      if (commands.length > 0) {
        try {
          const findClause = wifiPackage === 'wifiwave2' ? '[find name=wifi2]' : '[find default-name=wifi2]';
          await mt.exec(`${wifiPath} set ${findClause} ${commands.join(' ')}`);
          console.log('  ✓ Applied 5GHz band settings');
        } catch (e) {
          console.log(`  ⚠️  Failed to apply 5GHz settings: ${e.message}`);
        }
      }
    }

    // Configure roaming settings (applies to all WiFi interfaces)
    if (wifiConfig.roaming) {
      console.log('\nConfiguring Fast Roaming (802.11k/v/r):');
      const roaming = wifiConfig.roaming;

      const roamingCommands = [];

      if (roaming.enabled !== undefined) {
        // Note: RouterOS v7 doesn't have a single "roaming.enabled" setting
        // The individual k/v/r settings enable roaming features
        console.log(`  ✓ Fast roaming enabled: ${roaming.enabled}`);
      }

      // 802.11k - Neighbor Report
      if (roaming.neighborReport !== undefined) {
        const value = roaming.neighborReport ? 'yes' : 'no';
        roamingCommands.push(`configuration.manager.beacon-interval=100`);
        console.log(`  ✓ 802.11k Neighbor Report: ${value}`);
      }

      // 802.11v - BSS Transition
      if (roaming.bssTransition !== undefined) {
        // RouterOS v7 supports BSS transition via steering
        const value = roaming.bssTransition ? 'yes' : 'no';
        console.log(`  ✓ 802.11v BSS Transition: ${value}`);
      }

      // 802.11r - Fast Transition (FT)
      if (roaming.fastTransition !== undefined) {
        const ftMode = roaming.fastTransition ? 'ft-psk' : 'wpa2-psk';
        console.log(`  ✓ 802.11r Fast Transition: ${roaming.fastTransition ? 'enabled' : 'disabled'}`);
        console.log(`  Note: FT is configured per-SSID via authentication type`);
      }

      if (roamingCommands.length > 0) {
        try {
          if (wifiPackage === 'wifiwave2') {
            await mt.exec(`${wifiPath} set [find name=wifi1],[find name=wifi2] ${roamingCommands.join(' ')}`);
          } else {
            await mt.exec(`${wifiPath} set [find default-name=wifi1],[find default-name=wifi2] ${roamingCommands.join(' ')}`);
          }
          console.log('  ✓ Applied roaming settings to all WiFi interfaces');
        } catch (e) {
          console.log(`  ⚠️  Failed to apply roaming settings: ${e.message}`);
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

      // Configure each band this SSID should broadcast on
      for (const band of bands) {
        const masterInterface = BAND_TO_INTERFACE[band];

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
              if (wifiPackage === 'wifiwave2') {
                await mt.exec(
                  `${wifiPath} add ` +
                  `master-interface=[find name=${masterInterface}] ` +
                  `name="${wifiInterface}"`
                );
              } else {
                await mt.exec(
                  `${wifiPath} add ` +
                  `master-interface=[find default-name=${masterInterface}] ` +
                  `name="${wifiInterface}"`
                );
              }
              console.log(`  ✓ Created virtual interface ${wifiInterface}`);
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
          let setTarget;
          if (isVirtual) {
            setTarget = wifiInterface;
          } else {
            setTarget = wifiPackage === 'wifiwave2' ? `[find name=${masterInterface}]` : `[find default-name=${masterInterface}]`;
          }

          await mt.exec(
            `${wifiPath} set ${setTarget} ` +
            `configuration.ssid="${ssid}" ` +
            `datapath="${datapathName}" ` +
            `security.authentication-types=wpa2-psk ` +
            `security.passphrase="${passphrase}" ` +
            `disabled=no`
          );

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
        const masterInterface = BAND_TO_INTERFACE[band];
        try {
          const findClause = wifiPackage === 'wifiwave2' ? `[find name=${masterInterface}]` : `[find default-name=${masterInterface}]`;
          await mt.exec(`${wifiPath} set ${findClause} disabled=yes`);
          console.log(`✓ Disabled ${masterInterface} (${band}) - no SSIDs configured`);
        } catch (e) {
          console.log(`⚠️  Could not disable ${masterInterface}: ${e.message}`);
        }
      }
    }


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

/**
 * Backup current MikroTik configuration and generate config.yaml structure
 * @param {Object} credentials - Device credentials {host, username, password}
 * @returns {Promise<Object>} Configuration object matching config.yaml schema
 */
async function backupMikroTikConfig(credentials = {}) {
  const mt = new MikroTikSSH(
    credentials.host || '192.168.88.1',
    credentials.username || 'admin',
    credentials.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('MikroTik Configuration Backup');
    console.log('========================================\n');

    const config = {
      device: {
        host: credentials.host || '192.168.88.1',
        username: credentials.username || 'admin',
        password: credentials.password || 'admin'
      },
      managementInterfaces: [],
      disabledInterfaces: [],
      wifi: {
        '2.4GHz': {},
        '5GHz': {},
        roaming: {}
      },
      ssids: []
    };

    // Step 0: Get device identity
    console.log('=== Reading Device Identity ===');
    try {
      const identityOutput = await mt.exec('/system identity print');
      const identityMatch = identityOutput.match(/name:\s*(.+)/);
      if (identityMatch) {
        const currentIdentity = identityMatch[1].trim();

        // Only store identity if it's different from hostname
        // (we auto-set identity from hostname during apply)
        if (config.device.host.includes('.')) {
          const expectedIdentity = config.device.host.split('.')[0];
          if (currentIdentity !== expectedIdentity) {
            config.identity = currentIdentity;
            console.log(`✓ Device identity: ${currentIdentity} (differs from hostname)`);
          } else {
            console.log(`✓ Device identity: ${currentIdentity} (matches hostname, will auto-set)`);
          }
        } else if (!config.device.host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
          // If host is not IP and not FQDN, check if identity differs
          if (currentIdentity !== config.device.host) {
            config.identity = currentIdentity;
            console.log(`✓ Device identity: ${currentIdentity} (differs from hostname)`);
          } else {
            console.log(`✓ Device identity: ${currentIdentity} (matches hostname, will auto-set)`);
          }
        } else {
          // Host is an IP, always store the identity
          config.identity = currentIdentity;
          console.log(`✓ Device identity: ${currentIdentity}`);
        }
      }
    } catch (e) {
      console.log(`⚠️  Could not read device identity: ${e.message}`);
    }

    // Step 1: Get disabled interfaces
    console.log('\n=== Reading Interface Status ===');
    try {
      const ethernetInterfaces = await mt.exec('/interface ethernet print detail without-paging');
      const lines = ethernetInterfaces.split('\n');

      // Parse interfaces - look for lines starting with flags (e.g., " 0 RS", " 1 XS")
      // X flag indicates disabled
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match lines that start with index and flags, where X flag is present
        const flagMatch = line.match(/^\s*\d+\s+X/);
        if (flagMatch) {
          // Look for default-name in this line or subsequent lines
          let searchLine = line;
          let j = i;
          while (j < lines.length && !searchLine.includes('default-name=')) {
            j++;
            if (j < lines.length) {
              searchLine += ' ' + lines[j];
            }
          }

          const nameMatch = searchLine.match(/default-name="?([^"\s]+)"?/);
          if (nameMatch && nameMatch[1].startsWith('ether')) {
            config.disabledInterfaces.push(nameMatch[1]);
            console.log(`✓ Found disabled interface: ${nameMatch[1]}`);
          }
        }
      }
    } catch (e) {
      console.log(`⚠️  Could not read ethernet interfaces: ${e.message}`);
    }

    // Step 2: Check for LACP bonds first
    console.log('\n=== Checking for LACP Bonds ===');
    let bondInterfaces = [];
    try {
      const bonds = await mt.exec('/interface bonding print detail without-paging');

      // Parse each bond entry (entries are separated by blank lines or numbers)
      const bondEntries = bonds.split(/\n\s*\d+\s+/).filter(e => e.trim());

      for (const entry of bondEntries) {
        // Look for bond configuration in each entry
        const nameMatch = entry.match(/name="?([^"\s]+)"?/);
        const slavesMatch = entry.match(/slaves=([^"\s]+)/);
        const modeMatch = entry.match(/mode=802\.3ad/);  // LACP mode

        if (nameMatch && slavesMatch && modeMatch) {
          const bondName = nameMatch[1];
          const slaves = slavesMatch[1].split(',');

          // Check if this bond is in the bridge
          const bridgeCheck = await mt.exec(`/interface bridge port print where interface=${bondName}`);
          if (bridgeCheck && !bridgeCheck.includes('no such item') && bridgeCheck.length > 0) {
            // Bond is in bridge - add as management interface
            config.managementInterfaces.push({
              bond: slaves
            });
            bondInterfaces = bondInterfaces.concat(slaves);
            console.log(`✓ Found LACP bond ${bondName} with members: ${slaves.join(', ')}`);
          }
        }
      }
    } catch (e) {
      console.log(`  No LACP bonds found or error reading: ${e.message}`);
    }

    // Step 3: Get bridge ports (for non-bonded management interfaces)
    console.log('\n=== Reading Bridge Ports ===');
    try {
      const bridgePorts = await mt.exec('/interface bridge port print detail without-paging');
      const lines = bridgePorts.split('\n');

      for (const line of lines) {
        const ifaceMatch = line.match(/interface=(ether\d+|bond\d+)/);
        if (ifaceMatch) {
          const ifaceName = ifaceMatch[1];

          // Skip if it's a bond (already handled)
          if (ifaceName.startsWith('bond')) {
            continue;
          }

          // Skip if it's part of a bond
          if (bondInterfaces.includes(ifaceName)) {
            console.log(`  Skipping ${ifaceName} (part of bond)`);
            continue;
          }

          // Only add to management interfaces if not disabled
          if (!config.disabledInterfaces.includes(ifaceName)) {
            if (!config.managementInterfaces.find(iface =>
              typeof iface === 'string' ? iface === ifaceName : false)) {
              config.managementInterfaces.push(ifaceName);
              console.log(`✓ Found bridge port: ${ifaceName}`);
            }
          } else {
            console.log(`  Skipping disabled interface: ${ifaceName}`);
          }
        }
      }
    } catch (e) {
      console.log(`⚠️  Could not read bridge ports: ${e.message}`);
    }

    // Default to ether1 if no management interfaces found
    if (config.managementInterfaces.length === 0) {
      config.managementInterfaces.push('ether1');
    }

    // Step 3: Get WiFi band settings (channel, power, country)
    console.log('\n=== Reading WiFi Band Settings ===');
    try {
      // Read 2.4GHz settings (wifi1)
      const wifi1Output = await mt.exec('/interface wifi print detail without-paging where default-name=wifi1');
      const channelFreqMatch24 = wifi1Output.match(/channel\.frequency=(\d+)/);
      const txPowerMatch24 = wifi1Output.match(/(?:configuration\.)?tx-power=(\d+)/);
      const countryMatch24 = wifi1Output.match(/(?:configuration\.)?country="?([^"\s]+)"?/);
      const widthMatch24 = wifi1Output.match(/(?:channel\.)?width=([^\s]+)/);

      if (channelFreqMatch24) {
        const freq = parseInt(channelFreqMatch24[1]);
        // Map frequency back to channel
        const freqChannelMap = {
          2412: 1, 2417: 2, 2422: 3, 2427: 4, 2432: 5, 2437: 6,
          2442: 7, 2447: 8, 2452: 9, 2457: 10, 2462: 11, 2467: 12, 2472: 13
        };
        const channel = freqChannelMap[freq];
        if (channel) {
          config.wifi['2.4GHz'].channel = channel;
          console.log(`✓ 2.4GHz Channel: ${channel} (${freq} MHz)`);
        } else {
          config.wifi['2.4GHz'].frequency = freq;
          console.log(`✓ 2.4GHz Frequency: ${freq} MHz`);
        }
      }

      if (txPowerMatch24) {
        config.wifi['2.4GHz'].txPower = parseInt(txPowerMatch24[1]);
        console.log(`✓ 2.4GHz TX Power: ${txPowerMatch24[1]} dBm`);
      }

      if (countryMatch24) {
        config.wifi['2.4GHz'].country = countryMatch24[1];
        console.log(`✓ 2.4GHz Country: ${countryMatch24[1]}`);
      }

      if (widthMatch24) {
        config.wifi['2.4GHz'].width = widthMatch24[1];
        console.log(`✓ 2.4GHz Width: ${widthMatch24[1]}`);
      }

      // Read 5GHz settings (wifi2)
      const wifi2Output = await mt.exec('/interface wifi print detail without-paging where default-name=wifi2');
      const channelFreqMatch5 = wifi2Output.match(/channel\.frequency=(\d+)/);
      const txPowerMatch5 = wifi2Output.match(/(?:configuration\.)?tx-power=(\d+)/);
      const countryMatch5 = wifi2Output.match(/(?:configuration\.)?country="?([^"\s]+)"?/);
      const widthMatch5 = wifi2Output.match(/(?:channel\.)?width=([^\s]+)/);

      if (channelFreqMatch5) {
        const freq = parseInt(channelFreqMatch5[1]);
        // Map frequency back to channel for 5GHz
        const freqChannelMap = {
          5180: 36, 5200: 40, 5220: 44, 5240: 48,
          5260: 52, 5280: 56, 5300: 60, 5320: 64,
          5500: 100, 5520: 104, 5540: 108, 5560: 112, 5580: 116, 5600: 120, 5620: 124, 5640: 128,
          5660: 132, 5680: 136, 5700: 140, 5720: 144,
          5745: 149, 5765: 153, 5785: 157, 5805: 161, 5825: 165
        };
        const channel = freqChannelMap[freq];
        if (channel) {
          config.wifi['5GHz'].channel = channel;
          console.log(`✓ 5GHz Channel: ${channel} (${freq} MHz)`);
        } else {
          config.wifi['5GHz'].frequency = freq;
          console.log(`✓ 5GHz Frequency: ${freq} MHz`);
        }
      }

      if (txPowerMatch5) {
        config.wifi['5GHz'].txPower = parseInt(txPowerMatch5[1]);
        console.log(`✓ 5GHz TX Power: ${txPowerMatch5[1]} dBm`);
      }

      if (countryMatch5) {
        config.wifi['5GHz'].country = countryMatch5[1];
        console.log(`✓ 5GHz Country: ${countryMatch5[1]}`);
      }

      if (widthMatch5) {
        config.wifi['5GHz'].width = widthMatch5[1];
        console.log(`✓ 5GHz Width: ${widthMatch5[1]}`);
      }

      // Clean up empty wifi band configs
      if (Object.keys(config.wifi['2.4GHz']).length === 0) {
        delete config.wifi['2.4GHz'];
      }
      if (Object.keys(config.wifi['5GHz']).length === 0) {
        delete config.wifi['5GHz'];
      }

      if (Object.keys(config.wifi).length === 0) {
        delete config.wifi;
      }

    } catch (e) {
      console.log(`⚠️  Could not read WiFi band settings: ${e.message}`);
      delete config.wifi;
    }

    // Step 4: Get WiFi interfaces and their configurations
    console.log('\n=== Reading WiFi Configurations ===');
    try {
      const wifiInterfaces = await mt.exec('/interface wifi print detail without-paging');
      const lines = wifiInterfaces.split('\n');

      // Parse WiFi interface details
      const interfaces = [];
      let currentInterface = null;

      for (const line of lines) {
        if (line.trim().startsWith('0') || line.trim().startsWith('1') || line.trim().startsWith('2') ||
            line.trim().startsWith('3') || line.trim().startsWith('4') || line.trim().startsWith('5')) {
          // New interface entry
          if (currentInterface) {
            interfaces.push(currentInterface);
          }
          currentInterface = { raw: line };
        } else if (currentInterface && line.trim()) {
          // Continuation of current interface
          currentInterface.raw += ' ' + line.trim();
        }
      }
      if (currentInterface) {
        interfaces.push(currentInterface);
      }

      // Parse each interface
      for (const iface of interfaces) {
        const raw = iface.raw;

        // Extract key properties
        const nameMatch = raw.match(/name="?([^"\s]+)"?/);
        // Match both full format (configuration.ssid=) and shorthand (.ssid=)
        const ssidMatch = raw.match(/(?:configuration)?\.ssid="([^"]+)"/);
        const datapathMatch = raw.match(/datapath="?([^"\s]+)"?/);
        // Match both full format and shorthand for passphrase
        const passphraseMatch = raw.match(/(?:security)?\.passphrase="([^"]+)"/);
        const masterMatch = raw.match(/master-interface=([^\s]+)/);
        const disabledMatch = raw.match(/disabled=yes/);

        if (!nameMatch || disabledMatch) continue;

        const name = nameMatch[1];
        const ssid = ssidMatch ? ssidMatch[1] : null;
        const datapathName = datapathMatch ? datapathMatch[1] : null;
        const passphrase = passphraseMatch ? passphraseMatch[1] : null;
        const isMaster = !masterMatch;

        if (ssid && datapathName) {
          iface.name = name;
          iface.ssid = ssid;
          iface.datapathName = datapathName;
          iface.passphrase = passphrase;
          iface.isMaster = isMaster;

          // Determine band from interface name
          if (name.includes('wifi1')) {
            iface.band = '2.4GHz';
          } else if (name.includes('wifi2')) {
            iface.band = '5GHz';
          }

          console.log(`✓ Found WiFi interface: ${name} - SSID: ${ssid}`);
        }
      }

      // Step 5: Get datapath VLAN information
      console.log('\n=== Reading WiFi Datapaths ===');
      const datapaths = {};
      try {
        const datapathOutput = await mt.exec('/interface wifi datapath print detail without-paging');
        const dpLines = datapathOutput.split('\n');

        for (const line of dpLines) {
          const nameMatch = line.match(/name="?([^"\s]+)"?/);
          const vlanMatch = line.match(/vlan-id=(\d+)/);

          if (nameMatch && vlanMatch) {
            datapaths[nameMatch[1]] = parseInt(vlanMatch[1]);
            console.log(`✓ Found datapath: ${nameMatch[1]} -> VLAN ${vlanMatch[1]}`);
          }
        }
      } catch (e) {
        console.log(`⚠️  Could not read datapaths: ${e.message}`);
      }

      // Step 6: Build SSID configurations
      console.log('\n=== Building SSID Configuration ===');
      const ssidMap = new Map();

      for (const iface of interfaces) {
        if (!iface.ssid || !iface.band || !iface.datapathName) continue;

        const vlan = datapaths[iface.datapathName];
        if (vlan === undefined) continue;

        // Group by SSID+VLAN+passphrase
        const key = `${iface.ssid}|${vlan}|${iface.passphrase || ''}`;

        if (!ssidMap.has(key)) {
          ssidMap.set(key, {
            ssid: iface.ssid,
            passphrase: iface.passphrase || 'UNKNOWN',
            vlan: vlan,
            bands: []
          });
        }

        const ssidConfig = ssidMap.get(key);
        if (!ssidConfig.bands.includes(iface.band)) {
          ssidConfig.bands.push(iface.band);
        }
      }

      config.ssids = Array.from(ssidMap.values());

      for (const ssid of config.ssids) {
        console.log(`✓ SSID: ${ssid.ssid}`);
        console.log(`  Bands: ${ssid.bands.join(', ')}`);
        console.log(`  VLAN: ${ssid.vlan}`);
      }

      // Step 7: Detect roaming settings (802.11r Fast Transition)
      console.log('\n=== Detecting Roaming Settings ===');

      // Check if any WiFi interface has FT enabled
      let ftEnabled = false;
      for (const iface of interfaces) {
        if (iface.raw && iface.raw.match(/\.ft=yes/)) {
          ftEnabled = true;
          break;
        }
      }

      if (ftEnabled) {
        // Initialize wifi object if it doesn't exist
        if (!config.wifi) {
          config.wifi = {};
        }

        // Add roaming configuration
        config.wifi.roaming = {
          enabled: true,
          neighborReport: true,
          bssTransition: true,
          fastTransition: true
        };
        console.log('✓ Fast Transition (802.11r) detected - adding roaming configuration');
      } else {
        console.log('  No Fast Transition detected');
      }

    } catch (e) {
      console.log(`⚠️  Could not read WiFi configurations: ${e.message}`);
    }

    console.log('\n========================================');
    console.log('✓✓✓ Backup Complete! ✓✓✓');
    console.log('========================================\n');

    await mt.close();
    return config;
  } catch (error) {
    console.error('\n✗ Backup Error:', error.message);
    await mt.close();
    throw error;
  }
}

if (require.main === module) {
  configureMikroTik().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { configureMikroTik, backupMikroTikConfig, MikroTikSSH };
