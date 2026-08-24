/**
 * MikroTik configuration backup
 * Reads device configuration and generates YAML-compatible structure
 */

const { MikroTikSSH } = require('./ssh-client');
const { FREQ_CHANNEL_24GHZ, FREQ_CHANNEL_5GHZ } = require('./constants');
const { backupAccessLists } = require('./access-list');
const { backupRouterConfig, splitDetailRecords } = require('./router');
const { getWifiPath } = require('./utils');

/**
 * True when a `print detail` record is flagged disabled.
 *
 * RouterOS marks this with an X in the flag field between the record index and
 * the first key=value; it never emits `disabled=yes` in detail output.
 *
 * @param {string} record
 * @returns {boolean}
 */
function isDisabledRecord(record) {
  const text = String(record || '');

  // The flag field sits between the record index and whatever comes next -
  // which may be the first key=value, a ";;;" comment, or a line break. An
  // earlier version required key=value on the same line, so a disabled radio
  // carrying a comment read as enabled.
  const flagField = text.match(/^\s*\d+\s+([A-Za-z]?(?:[A-Za-z ]*[A-Za-z])?)\s*(?=;;;|[a-z][a-z-]*=|[\r\n]|$)/);
  if (flagField) return /\bX\b|X/.test(flagField[1]);

  // No recognisable flag field. Fall back rather than guessing "enabled".
  return /disabled=yes/.test(text);
}

/**
 * Pull a country name out of RouterOS "print detail" output.
 *
 * RouterOS prints this value unquoted even though it contains a space, e.g.
 * `.country=United States`, so a quoted-only match silently finds nothing.
 * Both forms are accepted here.
 *
 * @param {string} output - Raw print detail output
 * @returns {string|null}
 */
function parseCountry(output) {
  if (!output) return null;
  const quoted = output.match(/\.?country="([^"]+)"/);
  if (quoted) return quoted[1];

  // Unquoted: run to the next `key=` token or the end of the line.
  const bare = output.match(/\.?country=((?:(?!\s+[\w.-]+=)[^\r\n])+)/);
  return bare ? bare[1].trim() : null;
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

    // Step 0.5: Read Bridge IGMP Snooping
    console.log('\n=== Reading Bridge IGMP Snooping ===');
    try {
      const bridgeOutput = await mt.exec('/interface bridge print detail where name=bridge');
      if (bridgeOutput.includes('igmp-snooping=yes')) {
        config.igmpSnooping = true;
        console.log('✓ IGMP snooping enabled');
      } else {
        console.log('✓ IGMP snooping disabled (default)');
      }
    } catch (e) {
      console.log(`⚠️  Could not read IGMP snooping: ${e.message}`);
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
      // A disabled radio's channel and width describe nothing the device is
      // doing. Reporting them puts settings in the backup that the source
      // config never declared, so the round-trip never matches.
      const wifi1Raw = await mt.exec('/interface wifi print detail without-paging where default-name=wifi1');
      const wifi1Output = isDisabledRecord(wifi1Raw.split(/\r?\n(?=\s{0,3}\d+\s)/).find(r => /=/.test(r)) || '')
        ? ''
        : wifi1Raw;
      const channelFreqMatch24 = wifi1Output.match(/channel\.frequency=(\d+)/);
      const txPowerMatch24 = wifi1Output.match(/(?:configuration\.)?tx-power=(\d+)/);
      const country24Value = parseCountry(wifi1Output);
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

      if (country24Value) {
        config.wifi['2.4GHz'].country = country24Value;
        console.log(`✓ 2.4GHz Country: ${country24Value}`);
      }

      if (widthMatch24) {
        config.wifi['2.4GHz'].width = widthMatch24[1];
        console.log(`✓ 2.4GHz Width: ${widthMatch24[1]}`);
      }

      // Read 5GHz settings (wifi2)
      const wifi2Raw = await mt.exec('/interface wifi print detail without-paging where default-name=wifi2');
      const wifi2Output = isDisabledRecord(wifi2Raw.split(/\r?\n(?=\s{0,3}\d+\s)/).find(r => /=/.test(r)) || '')
        ? ''
        : wifi2Raw;
      const channelFreqMatch5 = wifi2Output.match(/channel\.frequency=(\d+)/);
      const txPowerMatch5 = wifi2Output.match(/(?:configuration\.)?tx-power=(\d+)/);
      const country5Value = parseCountry(wifi2Output);
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

      if (country5Value) {
        config.wifi['5GHz'].country = country5Value;
        console.log(`✓ 5GHz Country: ${country5Value}`);
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

      // The roaming placeholder is never populated here; leaving it in emits an
      // empty map that is not valid input.
      if (config.wifi.roaming && Object.keys(config.wifi.roaming).length === 0) {
        delete config.wifi.roaming;
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

      // Split into records the same way every other reader does. The previous
      // loop treated any trimmed line starting with 0-5 as a new record, which
      // meant a device with six or more WiFi interfaces - two radios plus four
      // virtual SSIDs is enough - merged the later ones into their predecessor,
      // and a continuation line beginning with a digit split a record in half.
      const interfaces = splitDetailRecords(wifiInterfaces)
        .map(record => ({ raw: record.replace(/\r?\n\s+/g, ' ') }));

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
        // `print detail` never emits disabled=yes. Disabled shows as an X in
        // the flag field between the record index and the first key=value,
        // so the old check never matched and disabled radios were backed up -
        // handing back SSIDs the device is not actually broadcasting.
        const disabledMatch = isDisabledRecord(raw);

        if (!nameMatch || disabledMatch) continue;

        const name = nameMatch[1];
        const ssid = ssidMatch ? ssidMatch[1] : null;
        const datapathName = datapathMatch ? datapathMatch[1] : null;
        const passphrase = passphraseMatch ? passphraseMatch[1] : null;
        const isMaster = !masterMatch;

        // Nothing in this codebase assigns a NAMED datapath to an interface -
        // configureWifiInterface writes `datapath.bridge=... datapath.vlan-id=N`
        // inline. So the VLAN has to be read off the interface itself. Reading
        // it only from a named datapath meant tagged SSIDs never round-tripped.
        // RouterOS prints the section shorthand, so both `datapath.vlan-id=`
        // and a bare `.vlan-id=` continuation have to match.
        const inlineVlanMatch = raw.match(/(?:datapath)?\.vlan-id=(\d+)/);

        if (ssid) {
          iface.name = name;
          iface.ssid = ssid;
          iface.datapathName = datapathName;
          iface.inlineVlan = inlineVlanMatch ? parseInt(inlineVlanMatch[1], 10) : undefined;
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
        if (!iface.ssid || !iface.band) continue;

        // Prefer the inline VLAN, fall back to a named datapath if one is
        // actually assigned. undefined means untagged, valid for role: router.
        const vlan = iface.inlineVlan !== undefined
          ? iface.inlineVlan
          : (iface.datapathName ? datapaths[iface.datapathName] : undefined);

        // Group by SSID+VLAN+passphrase
        const key = `${iface.ssid}|${vlan === undefined ? 'untagged' : vlan}|${iface.passphrase || ''}`;

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
          bands: ssidConfig.bands
        };

        // Omit vlan entirely for untagged SSIDs, matching how they are written.
        if (ssidConfig.vlan !== undefined) {
          result.vlan = ssidConfig.vlan;
        }

        // Add roaming config if FT is enabled for this SSID
        if (ssidConfig.hasFastTransition) {
          result.roaming = { fastTransition: true };
        }

        return result;
      });

      for (const ssid of config.ssids) {
        console.log(`✓ SSID: ${ssid.ssid}`);
        console.log(`  Bands: ${ssid.bands.join(', ')}`);
        console.log(`  VLAN: ${ssid.vlan === undefined ? 'untagged' : ssid.vlan}`);
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

    // Step 10: Read Access-List Configuration (WAP Locking + Fleet Blocking)
    // _lockedDevices is distributed to device configs by backup-multiple-devices.js
    // blockedDevices stays at the top level (it's fleet-wide).
    try {
      // wifi-qcom is the only supported package (v5.0.0+)
      const wifiPath = getWifiPath('wifi-qcom');

      const { lockedDevices, blockedDevices } = await backupAccessLists(mt, wifiPath);
      if (lockedDevices.length > 0) {
        config._lockedDevices = lockedDevices;
      }
      if (blockedDevices.length > 0) {
        config.blockedDevices = blockedDevices;
      }
    } catch (e) {
      console.log(`⚠️  Could not read access-list configuration: ${e.message}`);
    }

    // Step 11: Read Router Configuration (role: router)
    // Detected by the wan: route comments this tool writes during apply.
    // A router's LAN ports are not "management interfaces", so that WAP-only
    // field is dropped when this matches.
    try {
      const router = await backupRouterConfig(mt);
      if (router) {
        config.role = 'router';
        config.lan = router.lan;
        config.wan = router.wan;
        delete config.managementInterfaces;
        delete config.disabledInterfaces;
      }
    } catch (e) {
      console.log(`⚠️  Could not read router configuration: ${e.message}`);
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

module.exports = { backupMikroTikConfig, parseCountry, isDisabledRecord };
