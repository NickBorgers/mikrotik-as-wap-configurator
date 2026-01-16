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
    this.connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.conn.on('ready', () => {
        console.log('✓ Connected to MikroTik device');
        this.connected = true;
        resolve();
      }).on('close', () => {
        this.connected = false;
      }).on('error', (err) => {
        this.connected = false;
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
      if (!this.connected) {
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
    return this.connected;
  }

  async close() {
    this.connected = false;
    this.conn.end();
  }
}

// Map band names to interface names (will be updated based on detected package)
const BAND_TO_INTERFACE = {
  '2.4GHz': 'wifi1',
  '5GHz': 'wifi2'
};

// Channel to frequency maps (avoid duplication)
const CHANNEL_FREQ_24GHZ = {
  1: 2412, 2: 2417, 3: 2422, 4: 2427, 5: 2432, 6: 2437,
  7: 2442, 8: 2447, 9: 2452, 10: 2457, 11: 2462, 12: 2467, 13: 2472
};

const CHANNEL_FREQ_5GHZ = {
  36: 5180, 40: 5200, 44: 5220, 48: 5240,
  52: 5260, 56: 5280, 60: 5300, 64: 5320,
  100: 5500, 104: 5520, 108: 5540, 112: 5560, 116: 5580, 120: 5600, 124: 5620, 128: 5640,
  132: 5660, 136: 5680, 140: 5700, 144: 5720,
  149: 5745, 153: 5765, 157: 5785, 161: 5805, 165: 5825
};

// Inverse maps for backup (frequency -> channel)
const FREQ_CHANNEL_24GHZ = Object.fromEntries(
  Object.entries(CHANNEL_FREQ_24GHZ).map(([k, v]) => [v, parseInt(k)])
);
const FREQ_CHANNEL_5GHZ = Object.fromEntries(
  Object.entries(CHANNEL_FREQ_5GHZ).map(([k, v]) => [v, parseInt(k)])
);

// Helper to get correct WiFi command path based on package type
function getWifiPath(wifiPackage, command) {
  const basePath = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2' : '/interface/wifi';
  return command ? `${basePath}/${command}` : basePath;
}

// Helper to escape special characters in strings for MikroTik RouterOS commands
// When strings are enclosed in double quotes, most special characters are safe.
// Only need to escape: \ (backslash), " (quote), and $ (variable expansion)
function escapeMikroTik(str) {
  if (!str) return str;
  return str
    .replace(/\\/g, '\\\\')  // Backslash first
    .replace(/"/g, '\\"')    // Double quote
    .replace(/\$/g, '\\$');  // Dollar sign (variable expansion)
  // Note: # ! ^ % ? are safe inside double quotes and should NOT be escaped
}

// Helper to get CAPsMAN command path based on package type
function getCapsmanPath(wifiPackage, command) {
  const basePath = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2/capsman' : '/interface/wifi/capsman';
  return command ? `${basePath}/${command}` : basePath;
}

// Helper to get CAP command path based on package type
function getCapPath(wifiPackage) {
  return wifiPackage === 'wifiwave2' ? '/interface/wifiwave2/cap' : '/interface/wifi/cap';
}

/**
 * Configure device as CAPsMAN Controller
 * Creates master configurations, provisioning rules, and enables CAPsMAN service
 */
async function configureController(config = {}) {
  const mt = new MikroTikSSH(
    config.host || '192.168.88.1',
    config.username || 'admin',
    config.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('MikroTik CAPsMAN Controller Configuration');
    console.log('========================================\n');

    const ssids = config.ssids || [];
    const capsmanConfig = config.capsman || {};

    if (ssids.length === 0) {
      console.log('⚠️  No SSIDs configured');
      await mt.close();
      return false;
    }

    // Step 0: Set device identity
    console.log('=== Step 0: Setting Device Identity ===');
    let deviceIdentity = config.identity;
    if (!deviceIdentity && config.host) {
      if (config.host.includes('.') && !config.host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        deviceIdentity = config.host.split('.')[0];
        console.log(`✓ Extracted hostname from FQDN: ${deviceIdentity}`);
      }
    }
    if (deviceIdentity) {
      try {
        await mt.exec(`/system identity set name="${deviceIdentity}"`);
        console.log(`✓ Device identity set to: ${deviceIdentity}`);
      } catch (e) {
        console.log(`⚠️  Could not set device identity: ${e.message}`);
      }
    }

    // Step 1: Detect WiFi package
    console.log('\n=== Step 1: Detecting WiFi Package ===');
    let wifiPackage = 'unknown';
    const packages = await mt.exec('/system package print terse where name~"wifi"');
    if (packages.includes('wifiwave2')) {
      wifiPackage = 'wifiwave2';
      console.log('✓ Using WiFiWave2 package');
    } else if (packages.includes('wifi-qcom') || packages.includes('wifi ')) {
      wifiPackage = 'wifi-qcom';
      console.log('✓ Using WiFi-QCOM package');
    } else {
      console.log('✗ No supported WiFi package found');
      await mt.close();
      return false;
    }

    const capsmanPath = getCapsmanPath(wifiPackage);
    const wifiPath = getWifiPath(wifiPackage);

    // Step 2: Ensure Bridge Exists
    console.log('\n=== Step 2: Ensuring Basic Infrastructure ===');
    try {
      const bridges = await mt.exec('/interface bridge print terse where name=bridge');
      if (!bridges || !bridges.trim()) {
        await mt.exec('/interface bridge add name=bridge');
        console.log('✓ Created bridge');
      } else {
        console.log('✓ Bridge already exists');
      }
    } catch (e) {
      console.log(`⚠️  Bridge check: ${e.message}`);
    }

    // Disable VLAN filtering for safety
    try {
      await mt.exec('/interface bridge set bridge vlan-filtering=no');
      console.log('✓ VLAN filtering disabled (safe for management)');
    } catch (e) {
      console.log(`⚠️  Could not disable VLAN filtering: ${e.message}`);
    }

    // Step 3: Configure management interfaces
    console.log('\n=== Step 3: Configuring Management Interfaces ===');
    const mgmtInterfaces = config.managementInterfaces || ['ether1'];
    for (const iface of mgmtInterfaces) {
      if (typeof iface === 'string') {
        try {
          await mt.exec(`/interface bridge port add bridge=bridge interface=${iface}`);
          console.log(`✓ Added ${iface} to bridge`);
        } catch (e) {
          if (e.message.includes('already have interface')) {
            console.log(`✓ ${iface} already in bridge`);
          } else {
            console.log(`⚠️  Could not add ${iface}: ${e.message}`);
          }
        }
      }
      // Note: LACP bonds for controller would go here if needed
    }

    // Disable unused interfaces
    const disabledInterfaces = config.disabledInterfaces || [];
    for (const iface of disabledInterfaces) {
      try {
        await mt.exec(`/interface ethernet set [find default-name=${iface}] disabled=yes`);
        console.log(`✓ Disabled ${iface}`);
      } catch (e) {
        console.log(`⚠️  Could not disable ${iface}: ${e.message}`);
      }
    }

    // Step 4: Enable DHCP client
    console.log('\n=== Step 4: Establishing Management via DHCP ===');
    try {
      await mt.exec('/ip dhcp-client add interface=bridge disabled=no');
      console.log('✓ Added DHCP client on bridge');
    } catch (e) {
      if (e.message.includes('already have')) {
        console.log('✓ DHCP client already exists');
      }
    }

    // Step 5: Clean up old CAPsMAN configurations
    console.log('\n=== Step 5: Cleaning Up Old CAPsMAN Configurations ===');
    try {
      // Remove existing provisioning rules
      await mt.exec(`${capsmanPath}/provisioning remove [find]`);
      console.log('✓ Removed old provisioning rules');
    } catch (e) {
      if (!e.message.includes('no such item')) {
        console.log(`⚠️  Provisioning cleanup: ${e.message}`);
      }
    }

    try {
      // Remove existing master configurations
      await mt.exec(`${capsmanPath}/configuration remove [find]`);
      console.log('✓ Removed old master configurations');
    } catch (e) {
      if (!e.message.includes('no such item')) {
        console.log(`⚠️  Configuration cleanup: ${e.message}`);
      }
    }

    // Step 6: Create master configurations for each SSID
    console.log('\n=== Step 6: Creating Master Configurations ===');
    const wifiConfig = config.wifi || {};
    const country = wifiConfig.country || 'United States';

    for (const ssidConfig of ssids) {
      const { ssid, passphrase, vlan, bands, roaming } = ssidConfig;

      if (!ssid || !passphrase || !vlan || !bands || bands.length === 0) {
        console.log(`⚠️  Skipping incomplete SSID: ${ssid || 'unnamed'}`);
        continue;
      }

      console.log(`\nConfiguring SSID: ${ssid}`);

      // Determine authentication types based on roaming config
      const useFT = roaming?.fastTransition === true;
      const useRRM = roaming?.rrm === true;
      const useWNM = roaming?.wnm === true;
      const transitionThreshold = roaming?.transitionThreshold || -80;

      // Build authentication types string
      let authTypes = 'wpa2-psk';
      if (useFT) {
        authTypes = 'wpa2-psk,ft-psk';
      }

      const escapedSsid = escapeMikroTik(ssid);
      const escapedPassphrase = escapeMikroTik(passphrase);

      // Create configuration for each band
      for (const band of bands) {
        const bandSuffix = band === '2.4GHz' ? '2g' : '5g';
        const configName = `cfg-${ssid.replace(/[^a-zA-Z0-9]/g, '')}-${bandSuffix}`;
        const bandSpec = band === '2.4GHz' ? '2ghz-ax,2ghz-n' : '5ghz-ax,5ghz-n,5ghz-ac';

        // Get band-specific settings
        const bandConfig = wifiConfig[band] || {};
        const channelCmd = bandConfig.channel ?
          `channel.frequency=${band === '2.4GHz' ? CHANNEL_FREQ_24GHZ[bandConfig.channel] : CHANNEL_FREQ_5GHZ[bandConfig.channel]}` : '';
        const txPowerCmd = bandConfig.txPower ? `channel.tx-power=${bandConfig.txPower}` : '';
        const widthCmd = bandConfig.width ? `channel.width=${bandConfig.width}` : '';

        // Build configuration command
        let configCmd = `${capsmanPath}/configuration add ` +
          `name="${configName}" ` +
          `ssid="${escapedSsid}" ` +
          `country="${country}" ` +
          `security.authentication-types=${authTypes} ` +
          `security.passphrase="${escapedPassphrase}" ` +
          `datapath.bridge=bridge ` +
          `datapath.vlan-id=${vlan}`;

        // Add 802.11r settings
        if (useFT) {
          configCmd += ` security.ft=yes security.ft-over-ds=yes`;
        }

        // Add 802.11k/v settings
        if (useRRM) {
          configCmd += ` steering.rrm=yes`;
        }
        if (useWNM) {
          configCmd += ` steering.wnm=yes steering.transition-threshold=${transitionThreshold}`;
        }

        // Add channel settings
        if (channelCmd) configCmd += ` ${channelCmd}`;
        if (txPowerCmd) configCmd += ` ${txPowerCmd}`;
        if (widthCmd) configCmd += ` ${widthCmd}`;

        try {
          await mt.exec(configCmd);
          console.log(`  ✓ Created master config: ${configName} (${band})`);
          if (useFT) console.log(`    802.11r: enabled`);
          if (useRRM) console.log(`    802.11k: enabled`);
          if (useWNM) console.log(`    802.11v: enabled (threshold: ${transitionThreshold} dBm)`);
        } catch (e) {
          console.log(`  ✗ Failed to create config ${configName}: ${e.message}`);
        }

        // Create provisioning rule for this band
        try {
          await mt.exec(
            `${capsmanPath}/provisioning add ` +
            `supported-bands=${bandSpec} ` +
            `master-configuration="${configName}" ` +
            `action=create-dynamic-enabled`
          );
          console.log(`  ✓ Created provisioning rule for ${bandSpec}`);
        } catch (e) {
          console.log(`  ⚠️  Provisioning rule: ${e.message}`);
        }
      }
    }

    // Step 7: Enable CAPsMAN service
    console.log('\n=== Step 7: Enabling CAPsMAN Service ===');
    const certificate = capsmanConfig.certificate || 'auto';
    const requirePeerCert = capsmanConfig.requirePeerCertificate ? 'yes' : 'no';

    try {
      await mt.exec(`${capsmanPath} set enabled=yes ca-certificate=${certificate} require-peer-certificate=${requirePeerCert}`);
      console.log(`✓ CAPsMAN enabled with certificate: ${certificate}`);
      if (capsmanConfig.requirePeerCertificate) {
        console.log('✓ Mutual certificate authentication enabled');
      }
    } catch (e) {
      console.log(`✗ Failed to enable CAPsMAN: ${e.message}`);
    }

    // Step 8: Configure local WiFi interfaces (controller also acts as AP)
    console.log('\n=== Step 8: Configuring Local WiFi (Controller as AP) ===');
    try {
      // Set local interfaces to use CAPsMAN configuration
      await mt.exec(`${wifiPath} set wifi1 configuration.manager=capsman-or-local`);
      await mt.exec(`${wifiPath} set wifi2 configuration.manager=capsman-or-local`);
      console.log('✓ Local WiFi interfaces set to CAPsMAN-managed');
    } catch (e) {
      console.log(`⚠️  Local WiFi config: ${e.message}`);
    }

    // Step 9: Configure Syslog (if specified)
    if (config.syslog && config.syslog.server) {
      console.log('\n=== Step 9: Configuring Remote Syslog ===');
      const syslogServer = config.syslog.server;
      const syslogPort = config.syslog.port || 514;
      const syslogTopics = config.syslog.topics || ['wireless'];

      try {
        await mt.exec(`/system logging action remove [find name="remotesyslog"]`);
      } catch (e) { /* ignore */ }

      try {
        await mt.exec(`/system logging remove [find action="remotesyslog"]`);
      } catch (e) { /* ignore */ }

      try {
        await mt.exec(
          `/system logging action add name="remotesyslog" target=remote ` +
          `remote=${syslogServer} remote-port=${syslogPort}`
        );
        for (const topic of syslogTopics) {
          await mt.exec(`/system logging add topics=${topic} action="remotesyslog"`);
        }
        console.log(`✓ Syslog configured: ${syslogServer}:${syslogPort}`);
      } catch (e) {
        console.log(`⚠️  Syslog config: ${e.message}`);
      }
    }

    console.log('\n========================================');
    console.log('✓✓✓ CAPsMAN Controller Configuration Complete! ✓✓✓');
    console.log('========================================');
    console.log('\nCAPsMAN is ready to accept CAP connections.');
    console.log('CAPs should connect to this device\'s IP address.');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ Controller Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

/**
 * Configure device as CAP (Controlled Access Point)
 * Connects to CAPsMAN controller and receives WiFi configuration
 */
async function configureCap(config = {}) {
  const mt = new MikroTikSSH(
    config.host || '192.168.88.1',
    config.username || 'admin',
    config.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('MikroTik CAP (Controlled Access Point) Configuration');
    console.log('========================================\n');

    const capConfig = config.cap || {};
    const controllerAddresses = capConfig.controllerAddresses || [];

    if (controllerAddresses.length === 0) {
      console.log('✗ No controller addresses specified');
      await mt.close();
      return false;
    }

    // Step 0: Set device identity
    console.log('=== Step 0: Setting Device Identity ===');
    let deviceIdentity = config.identity;
    if (!deviceIdentity && config.host) {
      if (config.host.includes('.') && !config.host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        deviceIdentity = config.host.split('.')[0];
        console.log(`✓ Extracted hostname from FQDN: ${deviceIdentity}`);
      }
    }
    if (deviceIdentity) {
      try {
        await mt.exec(`/system identity set name="${deviceIdentity}"`);
        console.log(`✓ Device identity set to: ${deviceIdentity}`);
      } catch (e) {
        console.log(`⚠️  Could not set device identity: ${e.message}`);
      }
    }

    // Step 1: Detect WiFi package
    console.log('\n=== Step 1: Detecting WiFi Package ===');
    let wifiPackage = 'unknown';
    const packages = await mt.exec('/system package print terse where name~"wifi"');
    if (packages.includes('wifiwave2')) {
      wifiPackage = 'wifiwave2';
      console.log('✓ Using WiFiWave2 package');
    } else if (packages.includes('wifi-qcom') || packages.includes('wifi ')) {
      wifiPackage = 'wifi-qcom';
      console.log('✓ Using WiFi-QCOM package');
    } else {
      console.log('✗ No supported WiFi package found');
      await mt.close();
      return false;
    }

    const capPath = getCapPath(wifiPackage);
    const wifiPath = getWifiPath(wifiPackage);

    // Step 2: Ensure Bridge Exists
    console.log('\n=== Step 2: Ensuring Basic Infrastructure ===');
    try {
      const bridges = await mt.exec('/interface bridge print terse where name=bridge');
      if (!bridges || !bridges.trim()) {
        await mt.exec('/interface bridge add name=bridge');
        console.log('✓ Created bridge');
      } else {
        console.log('✓ Bridge already exists');
      }
    } catch (e) {
      console.log(`⚠️  Bridge check: ${e.message}`);
    }

    // Disable VLAN filtering for safety
    try {
      await mt.exec('/interface bridge set bridge vlan-filtering=no');
      console.log('✓ VLAN filtering disabled (safe for management)');
    } catch (e) {
      console.log(`⚠️  Could not disable VLAN filtering: ${e.message}`);
    }

    // Step 3: Configure management interfaces
    console.log('\n=== Step 3: Configuring Management Interfaces ===');
    const mgmtInterfaces = config.managementInterfaces || ['ether1'];
    for (const iface of mgmtInterfaces) {
      if (typeof iface === 'string') {
        try {
          await mt.exec(`/interface bridge port add bridge=bridge interface=${iface}`);
          console.log(`✓ Added ${iface} to bridge`);
        } catch (e) {
          if (e.message.includes('already have interface')) {
            console.log(`✓ ${iface} already in bridge`);
          } else {
            console.log(`⚠️  Could not add ${iface}: ${e.message}`);
          }
        }
      }
    }

    // Disable unused interfaces
    const disabledInterfaces = config.disabledInterfaces || [];
    for (const iface of disabledInterfaces) {
      try {
        await mt.exec(`/interface ethernet set [find default-name=${iface}] disabled=yes`);
        console.log(`✓ Disabled ${iface}`);
      } catch (e) {
        console.log(`⚠️  Could not disable ${iface}: ${e.message}`);
      }
    }

    // Step 4: Enable DHCP client
    console.log('\n=== Step 4: Establishing Management via DHCP ===');
    try {
      await mt.exec('/ip dhcp-client add interface=bridge disabled=no');
      console.log('✓ Added DHCP client on bridge');
    } catch (e) {
      if (e.message.includes('already have')) {
        console.log('✓ DHCP client already exists');
      }
    }

    // Step 5: Configure WiFi interfaces for CAPsMAN management
    console.log('\n=== Step 5: Configuring WiFi Interfaces for CAPsMAN ===');

    // Apply local channel overrides if specified
    const wifiConfig = config.wifi || {};

    // Get board info to detect radio layout
    let interface24 = 'wifi1';
    let interface5 = 'wifi2';
    try {
      const resource = await mt.exec('/system resource print');
      const boardMatch = resource.match(/board-name:\s*([^\n]+)/);
      const boardName = boardMatch ? boardMatch[1].trim().toLowerCase() : '';
      const swappedRadioDevices = ['cap ax', 'cap ac'];
      if (swappedRadioDevices.some(d => boardName.includes(d))) {
        interface24 = 'wifi2';
        interface5 = 'wifi1';
        console.log(`ℹ️  ${boardMatch[1].trim()}: Swapped radio layout`);
      }
    } catch (e) {
      console.log('⚠️  Could not detect board, assuming standard layout');
    }

    // Apply local channel settings (these override controller defaults)
    if (wifiConfig['2.4GHz']) {
      const config24 = wifiConfig['2.4GHz'];
      const commands = [];
      if (config24.channel) {
        const freq = CHANNEL_FREQ_24GHZ[config24.channel];
        if (freq) commands.push(`channel.frequency=${freq}`);
      }
      if (config24.txPower) commands.push(`channel.tx-power=${config24.txPower}`);
      if (commands.length > 0) {
        try {
          await mt.exec(`${wifiPath} set ${interface24} ${commands.join(' ')}`);
          console.log(`✓ Applied local 2.4GHz settings: ${commands.join(', ')}`);
        } catch (e) {
          console.log(`⚠️  2.4GHz settings: ${e.message}`);
        }
      }
    }

    if (wifiConfig['5GHz']) {
      const config5 = wifiConfig['5GHz'];
      const commands = [];
      if (config5.channel) {
        const freq = CHANNEL_FREQ_5GHZ[config5.channel];
        if (freq) commands.push(`channel.frequency=${freq}`);
      }
      if (config5.txPower) commands.push(`channel.tx-power=${config5.txPower}`);
      if (commands.length > 0) {
        try {
          await mt.exec(`${wifiPath} set ${interface5} ${commands.join(' ')}`);
          console.log(`✓ Applied local 5GHz settings: ${commands.join(', ')}`);
        } catch (e) {
          console.log(`⚠️  5GHz settings: ${e.message}`);
        }
      }
    }

    // Set interfaces to CAPsMAN-managed mode
    try {
      await mt.exec(`${wifiPath} set wifi1 configuration.manager=capsman-or-local`);
      await mt.exec(`${wifiPath} set wifi2 configuration.manager=capsman-or-local`);
      console.log('✓ WiFi interfaces set to CAPsMAN-managed mode');
    } catch (e) {
      console.log(`⚠️  Manager mode: ${e.message}`);
    }

    // Step 6: Enable CAP mode
    console.log('\n=== Step 6: Enabling CAP Mode ===');
    const addressList = controllerAddresses.join(',');
    const certificate = capConfig.certificate || 'request';
    const lockToController = capConfig.lockToController ? 'yes' : 'no';

    try {
      // First disable CAP if it was enabled (clean state)
      await mt.exec(`${capPath} set enabled=no`);
    } catch (e) { /* ignore */ }

    try {
      await mt.exec(
        `${capPath} set enabled=yes ` +
        `caps-man-addresses=${addressList} ` +
        `certificate=${certificate} ` +
        `lock-to-caps-man=${lockToController}`
      );
      console.log(`✓ CAP enabled, connecting to: ${addressList}`);
      if (capConfig.lockToController) {
        console.log('✓ Locked to specified controller');
      }
    } catch (e) {
      console.log(`✗ Failed to enable CAP: ${e.message}`);
    }

    // Step 7: Configure Syslog (if specified)
    if (config.syslog && config.syslog.server) {
      console.log('\n=== Step 7: Configuring Remote Syslog ===');
      const syslogServer = config.syslog.server;
      const syslogPort = config.syslog.port || 514;
      const syslogTopics = config.syslog.topics || ['wireless'];

      try {
        await mt.exec(`/system logging action remove [find name="remotesyslog"]`);
      } catch (e) { /* ignore */ }

      try {
        await mt.exec(`/system logging remove [find action="remotesyslog"]`);
      } catch (e) { /* ignore */ }

      try {
        await mt.exec(
          `/system logging action add name="remotesyslog" target=remote ` +
          `remote=${syslogServer} remote-port=${syslogPort}`
        );
        for (const topic of syslogTopics) {
          await mt.exec(`/system logging add topics=${topic} action="remotesyslog"`);
        }
        console.log(`✓ Syslog configured: ${syslogServer}:${syslogPort}`);
      } catch (e) {
        console.log(`⚠️  Syslog config: ${e.message}`);
      }
    }

    console.log('\n========================================');
    console.log('✓✓✓ CAP Configuration Complete! ✓✓✓');
    console.log('========================================');
    console.log(`\nCAP will connect to CAPsMAN at: ${addressList}`);
    console.log('WiFi configuration will be received from the controller.');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ CAP Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

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
    if (config.syslog && config.syslog.server) {
      console.log('\n=== Step 8: Configuring Remote Syslog ===');

      const syslogServer = config.syslog.server;
      const syslogPort = config.syslog.port || 514;
      const syslogTopics = config.syslog.topics || ['wireless'];
      const syslogActionName = 'remotesyslog';  // MikroTik only allows letters and numbers

      try {
        // Remove existing remote syslog action if it exists (to ensure idempotency)
        try {
          await mt.exec(`/system logging action remove [find name="${syslogActionName}"]`);
          console.log(`✓ Removed existing syslog action "${syslogActionName}"`);
        } catch (e) {
          // Ignore - action might not exist
        }

        // Remove existing logging rules for our action
        try {
          await mt.exec(`/system logging remove [find action="${syslogActionName}"]`);
          console.log('✓ Removed existing syslog logging rules');
        } catch (e) {
          // Ignore - rules might not exist
        }

        // Create remote syslog action
        // Note: Using 'default' format because 'syslog' format breaks some syslog receivers
        // WAP identification should be done via source IP in the receiver
        await mt.exec(
          `/system logging action add ` +
          `name="${syslogActionName}" ` +
          `target=remote ` +
          `remote=${syslogServer} ` +
          `remote-port=${syslogPort}`
        );
        console.log(`✓ Created syslog action: ${syslogServer}:${syslogPort}`);

        // Add logging rules for each topic
        for (const topic of syslogTopics) {
          await mt.exec(
            `/system logging add ` +
            `topics=${topic} ` +
            `action="${syslogActionName}"`
          );
          console.log(`✓ Logging topic "${topic}" to remote syslog`);
        }

        console.log(`✓ Syslog configured - WiFi events will be sent to ${syslogServer}:${syslogPort}`);
      } catch (e) {
        console.log(`⚠️  Could not configure syslog: ${e.message}`);
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
        const primaryMatch = entry.match(/primary=([^"\s]+)/);

        if (nameMatch && slavesMatch && modeMatch) {
          const bondName = nameMatch[1];
          let slaves = slavesMatch[1].split(',');
          const primary = primaryMatch ? primaryMatch[1] : null;

          // Ensure primary interface is first in the list (for consistent MAC address)
          if (primary && slaves.includes(primary)) {
            slaves = [primary, ...slaves.filter(s => s !== primary)];
          }

          // Check if this bond is in the bridge
          const bridgeCheck = await mt.exec(`/interface bridge port print where interface=${bondName}`);
          if (bridgeCheck && !bridgeCheck.includes('no such item') && bridgeCheck.length > 0) {
            // Bond is in bridge - add as management interface
            config.managementInterfaces.push({
              bond: slaves
            });
            bondInterfaces = bondInterfaces.concat(slaves);
            const primaryInfo = primary ? ` (primary: ${primary})` : '';
            console.log(`✓ Found LACP bond ${bondName} with members: ${slaves.join(', ')}${primaryInfo}`);
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
      const countryMatch24 = wifi1Output.match(/(?:configuration\.)?country="([^"]+)"/);
      const widthMatch24 = wifi1Output.match(/(?:channel\.)?width=([^\s]+)/);

      if (channelFreqMatch24) {
        const freq = parseInt(channelFreqMatch24[1]);
        const channel = FREQ_CHANNEL_24GHZ[freq];
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
      const countryMatch5 = wifi2Output.match(/(?:configuration\.)?country="([^"]+)"/);
      const widthMatch5 = wifi2Output.match(/(?:channel\.)?width=([^\s]+)/);

      if (channelFreqMatch5) {
        const freq = parseInt(channelFreqMatch5[1]);
        const channel = FREQ_CHANNEL_5GHZ[freq];
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

      // Promote country to wifi level if both bands have the same country
      const country24 = config.wifi['2.4GHz']?.country;
      const country5 = config.wifi['5GHz']?.country;
      if (country24 && country5 && country24 === country5) {
        config.wifi.country = country24;
        delete config.wifi['2.4GHz'].country;
        delete config.wifi['5GHz'].country;
        console.log(`✓ Country promoted to wifi level: ${country24}`);
      } else if (country24 && !country5) {
        // Only 2.4GHz has country, promote it
        config.wifi.country = country24;
        delete config.wifi['2.4GHz'].country;
        console.log(`✓ Country promoted to wifi level: ${country24}`);
      } else if (country5 && !country24) {
        // Only 5GHz has country, promote it
        config.wifi.country = country5;
        delete config.wifi['5GHz'].country;
        console.log(`✓ Country promoted to wifi level: ${country5}`);
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

          // Detect Fast Transition (802.11r) per-interface
          iface.hasFastTransition = !!(raw.match(/authentication-types[=:].*ft-psk/) || raw.match(/\.ft=yes/));

          console.log(`✓ Found WiFi interface: ${name} - SSID: ${ssid}${iface.hasFastTransition ? ' (FT enabled)' : ''}`);
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

      // Step 6: Build SSID configurations with per-SSID roaming detection
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
            bands: [],
            hasFastTransition: false
          });
        }

        const ssidConfig = ssidMap.get(key);
        if (!ssidConfig.bands.includes(iface.band)) {
          ssidConfig.bands.push(iface.band);
        }

        // Track if any interface for this SSID has FT enabled
        if (iface.hasFastTransition) {
          ssidConfig.hasFastTransition = true;
        }
      }

      config.ssids = Array.from(ssidMap.values()).map(ssidConfig => {
        const result = {
          ssid: ssidConfig.ssid,
          passphrase: ssidConfig.passphrase,
          vlan: ssidConfig.vlan,
          bands: ssidConfig.bands
        };

        // Add roaming config if FT is enabled for this SSID
        if (ssidConfig.hasFastTransition) {
          result.roaming = { fastTransition: true };
        }

        return result;
      });

      for (const ssid of config.ssids) {
        console.log(`✓ SSID: ${ssid.ssid}`);
        console.log(`  Bands: ${ssid.bands.join(', ')}`);
        console.log(`  VLAN: ${ssid.vlan}`);
        if (ssid.roaming?.fastTransition) {
          console.log(`  802.11r: enabled`);
        }
      }

    } catch (e) {
      console.log(`⚠️  Could not read WiFi configurations: ${e.message}`);
    }

    // Step 8: Read Syslog Configuration
    console.log('\n=== Reading Syslog Configuration ===');
    try {
      // Look for our remotesyslog action
      const actionOutput = await mt.exec('/system logging action print detail without-paging where name="remotesyslog"');

      if (actionOutput && actionOutput.includes('remotesyslog')) {
        // Parse the remote server and port
        const remoteMatch = actionOutput.match(/remote=([^\s]+)/);
        const portMatch = actionOutput.match(/remote-port=(\d+)/);

        if (remoteMatch) {
          config.syslog = {
            server: remoteMatch[1],
            port: portMatch ? parseInt(portMatch[1]) : 514,
            topics: []
          };

          // Get the topics configured for this action
          const loggingOutput = await mt.exec('/system logging print detail without-paging where action="remotesyslog"');
          const topicMatches = loggingOutput.matchAll(/topics=([^\s]+)/g);

          for (const match of topicMatches) {
            const topic = match[1];
            if (!config.syslog.topics.includes(topic)) {
              config.syslog.topics.push(topic);
            }
          }

          console.log(`✓ Found syslog configuration: ${config.syslog.server}:${config.syslog.port}`);
          console.log(`  Topics: ${config.syslog.topics.join(', ')}`);
        }
      } else {
        console.log('  No remote syslog configured');
      }
    } catch (e) {
      console.log(`⚠️  Could not read syslog configuration: ${e.message}`);
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

module.exports = {
  configureMikroTik,
  configureController,
  configureCap,
  backupMikroTikConfig,
  MikroTikSSH
};
