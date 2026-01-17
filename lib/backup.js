/**
 * MikroTik configuration backup
 * Reads device configuration and generates YAML-compatible structure
 */

const { MikroTikSSH } = require('./ssh-client');
const { FREQ_CHANNEL_24GHZ, FREQ_CHANNEL_5GHZ } = require('./constants');
const { backupAccessLists } = require('./access-list');
const { getWifiPath } = require('./utils');

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

    // Step 9: Read CAPsMAN VLAN Configuration
    console.log('\n=== Reading CAPsMAN VLAN Configuration ===');
    try {
      // Look for capsman-vlan interface
      const vlanOutput = await mt.exec('/interface vlan print detail without-paging where name=capsman-vlan');

      if (vlanOutput && vlanOutput.includes('capsman-vlan')) {
        // Parse the VLAN ID
        const vlanIdMatch = vlanOutput.match(/vlan-id=(\d+)/);

        if (vlanIdMatch) {
          const vlanId = parseInt(vlanIdMatch[1]);

          // Get the IP address on this interface
          const ipOutput = await mt.exec('/ip address print detail without-paging where interface=capsman-vlan');
          const ipMatch = ipOutput.match(/address=(\d+\.\d+\.\d+\.\d+)\/(\d+)/);

          if (ipMatch) {
            const ip = ipMatch[1];
            const prefix = ipMatch[2];

            // Calculate network address from IP and prefix
            const ipParts = ip.split('.').map(Number);
            const prefixNum = parseInt(prefix);
            const mask = ~((1 << (32 - prefixNum)) - 1) >>> 0;
            const networkParts = [
              (ipParts[0] & (mask >>> 24)) & 255,
              (ipParts[1] & (mask >>> 16)) & 255,
              (ipParts[2] & (mask >>> 8)) & 255,
              (ipParts[3] & mask) & 255
            ];
            const network = `${networkParts.join('.')}/${prefix}`;

            // Store CAPsMAN VLAN inside capsman for unified format
            if (!config.capsman) config.capsman = {};
            config.capsman.vlan = {
              id: vlanId,
              network: network,
              address: ip
            };

            console.log(`✓ Found CAPsMAN VLAN: ${vlanId}`);
            console.log(`  Network: ${network}`);
            console.log(`  Device IP: ${ip}`);
          } else {
            console.log(`⚠️  Found capsman-vlan but no IP address assigned`);
          }
        }
      } else {
        console.log('  No CAPsMAN VLAN configured');
      }
    } catch (e) {
      console.log(`⚠️  Could not read CAPsMAN VLAN configuration: ${e.message}`);
    }

    // Step 10: Read Access-List Configuration (WAP Locking)
    // This is stored as _lockedDevices for later distribution to device configs
    try {
      // Detect WiFi package to get the correct path
      let wifiPackage = 'wifiwave2'; // default
      const packageCheck = await mt.exec('/system package print where name~"wifi"');
      if (packageCheck.includes('wifi-qcom')) {
        wifiPackage = 'wifi-qcom';
      }
      const wifiPath = getWifiPath(wifiPackage);

      const lockedDevices = await backupAccessLists(mt, wifiPath);
      if (lockedDevices.length > 0) {
        config._lockedDevices = lockedDevices;
      }
    } catch (e) {
      console.log(`⚠️  Could not read access-list configuration: ${e.message}`);
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

module.exports = { backupMikroTikConfig };
