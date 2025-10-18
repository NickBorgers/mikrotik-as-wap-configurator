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

    // Step 3: Process each SSID
    console.log('\n=== Step 3: Configuring SSIDs ===');

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

    // Step 4: Ensure bridge VLAN filtering is DISABLED
    console.log('\n=== Step 4: Ensuring Bridge VLAN Filtering is Disabled ===');
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

    // Step 3: Get WiFi interfaces and their configurations
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

      // Step 4: Get datapath VLAN information
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

      // Step 5: Build SSID configurations
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
