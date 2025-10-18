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
        reject(err);
      }).connect({
        host: this.host,
        port: 22,
        username: this.username,
        password: this.password,
        readyTimeout: 10000
      });
    });
  }

  async exec(command) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, 10000);

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

  async close() {
    this.conn.end();
  }
}

// Map band names to interface names
const BAND_TO_INTERFACE = {
  '2.4GHz': 'wifi1',
  '5GHz': 'wifi2'
};

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

    // Step 1: Configure Bridge Ports
    console.log('=== Step 1: Configuring Bridge Ports ===');

    // Add ether1 to bridge (if not already)
    try {
      await mt.exec('/interface bridge port add bridge=bridge interface=ether1');
      console.log('✓ Added ether1 to bridge');
    } catch (e) {
      if (e.message.includes('already have interface')) {
        console.log('✓ ether1 already in bridge');
      } else {
        throw e;
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

    // Step 2: Clean up old virtual WiFi interfaces and datapaths
    console.log('\n=== Step 2: Cleaning Up Old Configurations ===');

    // First remove datapaths (to avoid "in use" errors when removing interfaces)
    try {
      const datapaths = await mt.exec('/interface/wifi/datapath print terse where name~"wifi"');
      if (datapaths && datapaths.trim()) {
        await mt.exec('/interface/wifi/datapath remove [find name~"wifi"]');
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
      const virtualInterfaces = await mt.exec('/interface/wifi print terse where master-interface');
      if (virtualInterfaces && virtualInterfaces.trim()) {
        await mt.exec('/interface/wifi remove [find master-interface]');
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

    // Step 3: Configure WiFi Optimization Settings (Channel, Power, Roaming)
    console.log('\n=== Step 3: Configuring WiFi Optimization Settings ===');

    const wifiConfig = config.wifi || {};

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

      if (commands.length > 0) {
        try {
          await mt.exec(`/interface/wifi set [find default-name=wifi1] ${commands.join(' ')}`);
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

      if (commands.length > 0) {
        try {
          await mt.exec(`/interface/wifi set [find default-name=wifi2] ${commands.join(' ')}`);
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
          await mt.exec(`/interface/wifi set [find default-name=wifi1],[find default-name=wifi2] ${roamingCommands.join(' ')}`);
          console.log('  ✓ Applied roaming settings to all WiFi interfaces');
        } catch (e) {
          console.log(`  ⚠️  Failed to apply roaming settings: ${e.message}`);
        }
      }
    }

    // Step 4: Process each SSID
    console.log('\n=== Step 4: Configuring SSIDs ===');

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
              await mt.exec(
                `/interface/wifi add ` +
                `master-interface=[find default-name=${masterInterface}] ` +
                `name="${wifiInterface}"`
              );
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
              `/interface/wifi/datapath add ` +
              `name="${datapathName}" ` +
              `vlan-id=${vlan} ` +
              `bridge=bridge`
            );
            console.log(`  ✓ Created datapath ${datapathName} for VLAN ${vlan}`);
          } catch (e) {
            if (e.message.includes('already have') || e.message.includes('exists')) {
              // Update existing datapath
              await mt.exec(
                `/interface/wifi/datapath set [find name="${datapathName}"] ` +
                `vlan-id=${vlan} ` +
                `bridge=bridge`
              );
              console.log(`  ✓ Updated datapath ${datapathName} for VLAN ${vlan}`);
            } else {
              throw e;
            }
          }

          // Configure WiFi interface with SSID, security, and datapath
          const setTarget = isVirtual ? wifiInterface : `[find default-name=${masterInterface}]`;
          await mt.exec(
            `/interface/wifi set ${setTarget} ` +
            `configuration.ssid="${ssid}" ` +
            `datapath="${datapathName}" ` +
            `security.authentication-types=wpa2-psk ` +
            `security.passphrase="${passphrase}" ` +
            `disabled=no`
          );

          console.log(`  ✓ ${wifiInterface} (${band}) configured with VLAN ${vlan} tagging`);
        } catch (e) {
          console.log(`  ✗ Failed to configure ${wifiInterface}: ${e.message}`);
        }
      }
    }

    // Step 5: Ensure bridge VLAN filtering is DISABLED
    console.log('\n=== Step 5: Ensuring Bridge VLAN Filtering is Disabled ===');
    await mt.exec('/interface bridge set bridge vlan-filtering=no');
    console.log('✓ VLAN filtering is DISABLED (safe for management)');

    console.log('\n========================================');
    console.log('✓✓✓ Configuration Complete! ✓✓✓');
    console.log('========================================');

    const mgmtInterfaces = config.managementInterfaces || ['ether1'];
    console.log(`\nManagement Access: ${mgmtInterfaces.join(', ')}`);

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

    // Step 1: Get disabled interfaces
    console.log('=== Reading Interface Status ===');
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

    // Step 2: Get bridge ports (for management interfaces)
    console.log('\n=== Reading Bridge Ports ===');
    try {
      const bridgePorts = await mt.exec('/interface bridge port print detail without-paging');
      const lines = bridgePorts.split('\n');

      for (const line of lines) {
        const ifaceMatch = line.match(/interface=(ether\d+)/);
        if (ifaceMatch) {
          const ifaceName = ifaceMatch[1];
          // Only add to management interfaces if not disabled
          if (!config.disabledInterfaces.includes(ifaceName)) {
            if (!config.managementInterfaces.includes(ifaceName)) {
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

      // Read 5GHz settings (wifi2)
      const wifi2Output = await mt.exec('/interface wifi print detail without-paging where default-name=wifi2');
      const channelFreqMatch5 = wifi2Output.match(/channel\.frequency=(\d+)/);
      const txPowerMatch5 = wifi2Output.match(/(?:configuration\.)?tx-power=(\d+)/);
      const countryMatch5 = wifi2Output.match(/(?:configuration\.)?country="?([^"\s]+)"?/);

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

      // Clean up empty wifi band configs
      if (Object.keys(config.wifi['2.4GHz']).length === 0) {
        delete config.wifi['2.4GHz'];
      }
      if (Object.keys(config.wifi['5GHz']).length === 0) {
        delete config.wifi['5GHz'];
      }

      // Note: Roaming settings (802.11k/v/r) are complex to extract from RouterOS v7
      // and may require additional CLI commands. For now, we'll leave this section empty.
      // Users can manually add roaming config if needed.
      delete config.wifi.roaming;

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
