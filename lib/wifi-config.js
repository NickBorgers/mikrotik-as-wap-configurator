/**
 * WiFi configuration helpers
 * Radio detection, band settings, and WiFi interface configuration
 */

const { CHANNEL_FREQ_24GHZ, CHANNEL_FREQ_5GHZ } = require('./constants');
const { escapeMikroTik, getWifiPath, getCapsmanPath } = require('./utils');

/**
 * Detect board type and return correct interface mapping for WiFi radios
 * Some MikroTik devices have swapped radio layouts
 * @param {MikroTikSSH} mt - Connected SSH session
 * @returns {Object} - { interface24: string, interface5: string }
 */
async function detectRadioLayout(mt) {
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

  return { interface24, interface5 };
}

/**
 * Apply WiFi channel settings for a specific band
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} band - '2.4GHz' or '5GHz'
 * @param {string} interfaceName - WiFi interface name
 * @param {Object} bandConfig - Band configuration (channel, txPower, width, country)
 * @param {string} wifiPath - WiFi command path
 */
async function applyBandSettings(mt, band, interfaceName, bandConfig, wifiPath) {
  if (!bandConfig) return;

  const commands = [];
  const channelFreqMap = band === '2.4GHz' ? CHANNEL_FREQ_24GHZ : CHANNEL_FREQ_5GHZ;

  if (bandConfig.channel) {
    const freq = channelFreqMap[bandConfig.channel];
    if (freq) commands.push(`channel.frequency=${freq}`);
  }
  if (bandConfig.txPower) commands.push(`channel.tx-power=${bandConfig.txPower}`);
  if (bandConfig.width) commands.push(`channel.width=${bandConfig.width}`);
  if (bandConfig.country) commands.push(`channel.country="${bandConfig.country}"`);

  if (commands.length > 0) {
    try {
      await mt.exec(`${wifiPath} set ${interfaceName} ${commands.join(' ')}`);
      console.log(`✓ Applied ${band} settings: ${commands.join(', ')}`);
    } catch (e) {
      console.log(`⚠️  ${band} settings: ${e.message}`);
    }
  }
}

/**
 * Configure a single WiFi interface with SSID, security, and datapath
 * Used for both standalone and CAPsMAN CAP interface configuration
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @param {string} interfaceName - Interface name to configure
 * @param {Object} ssidConfig - SSID configuration {ssid, passphrase, vlan, roaming}
 * @param {string} country - Country code for WiFi
 */
async function configureWifiInterface(mt, wifiPath, interfaceName, ssidConfig, country) {
  const { ssid, passphrase, vlan, roaming } = ssidConfig;

  const useFT = roaming?.fastTransition === true;
  const useRRM = roaming?.rrm === true;
  const useWNM = roaming?.wnm === true;
  const transitionThreshold = roaming?.transitionThreshold || -80;
  const escapedSsid = escapeMikroTik(ssid);
  const escapedPassphrase = escapeMikroTik(passphrase);

  // Create or update steering profile if RRM or WNM is enabled
  // wifi-qcom requires steering profiles as separate objects, not inline properties
  let steeringParam = '';
  if (useRRM || useWNM) {
    const steeringName = `steering-${interfaceName}`;
    try {
      // Remove existing steering profile if it exists
      await mt.exec(`${wifiPath}/steering remove [find name="${steeringName}"]`);
    } catch (e) {
      // Ignore if doesn't exist
    }
    // Create new steering profile
    const steeringCmd = `${wifiPath}/steering add name="${steeringName}" ` +
      `rrm=${useRRM ? 'yes' : 'no'} wnm=${useWNM ? 'yes' : 'no'}`;
    try {
      await mt.exec(steeringCmd);
      steeringParam = ` steering="${steeringName}"`;
    } catch (e) {
      console.log(`  ⚠️  Could not create steering profile: ${e.message}`);
    }
  }

  // Build configuration command
  // For wifi-qcom, use security.ft=yes instead of ft-psk auth type
  let cmd = `${wifiPath} set ${interfaceName} ` +
    `configuration.ssid="${escapedSsid}" ` +
    `configuration.country="${country}" ` +
    `security.authentication-types=wpa2-psk ` +
    `security.passphrase="${escapedPassphrase}" ` +
    `datapath.bridge=bridge datapath.vlan-id=${vlan}`;

  if (useFT) {
    cmd += ` security.ft=yes security.ft-over-ds=yes`;
  } else {
    // Explicitly disable FT when not configured to clear any previous settings
    cmd += ` security.ft=no security.ft-over-ds=no`;
  }

  // Add steering profile reference if created
  cmd += steeringParam;

  cmd += ` disabled=no`;

  try {
    await mt.exec(cmd);
    const roamingStatus = [
      useFT ? '802.11r' : '',
      useRRM ? '802.11k' : '',
      useWNM ? `802.11v(${transitionThreshold}dBm)` : ''
    ].filter(Boolean).join(', ');
    console.log(`  ✓ Configured ${interfaceName}: SSID="${ssid}", VLAN=${vlan}${roamingStatus ? `, ${roamingStatus}` : ''}`);
  } catch (e) {
    console.log(`  ✗ Failed to configure ${interfaceName}: ${e.message}`);
    throw e;
  }
}

/**
 * Get list of CAP identities with swapped radios from remote-cap information
 * Queries CAPsMAN to find connected CAPs and checks their board type
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPackage - WiFi package type (wifi-qcom or wifiwave2)
 * @returns {Set<string>} - Set of CAP identities that have swapped radios
 */
async function getSwappedRadioCaps(mt, wifiPackage) {
  const swappedCaps = new Set();

  // Known devices with swapped radios (wifi1=5GHz, wifi2=2.4GHz)
  // Includes both user-friendly names and internal product codes
  const swappedRadioPatterns = [
    // cAP ax variants
    'cap ax',           // User-friendly name (from /system resource)
    'capgi-5haxd2haxd', // Product code (from remote-cap)
    // cAP ac variants
    'cap ac',           // User-friendly name
    'capgi-5acd2nd',    // Product code (estimated)
  ];

  try {
    const capsmanPath = getCapsmanPath(wifiPackage);
    const remoteCaps = await mt.exec(`${capsmanPath}/remote-cap print detail without-paging`);

    // Parse each CAP entry
    // Format: identity="cap-name" ... board-name="cAPGi-5HaxD2HaxD"
    const capEntries = remoteCaps.split(/\n(?=\s*\d+\s+)/);

    for (const entry of capEntries) {
      const identityMatch = entry.match(/identity="?([^"\s]+)"?/);
      // Match both board= and board-name= formats
      const boardMatch = entry.match(/board(?:-name)?="([^"]+)"/);

      if (identityMatch && boardMatch) {
        const identity = identityMatch[1];
        const board = boardMatch[1].toLowerCase();

        if (swappedRadioPatterns.some(pattern => board.includes(pattern))) {
          swappedCaps.add(identity);
          console.log(`ℹ️  CAP "${identity}" (${boardMatch[1]}): Has swapped radios (wifi1=5GHz, wifi2=2.4GHz)`);
        }
      }
    }
  } catch (e) {
    console.log(`⚠️  Could not query remote CAPs: ${e.message}`);
  }

  return swappedCaps;
}

/**
 * Build a mapping of interface name to actual radio band from radio hardware info
 * The radio 'bands' property definitively shows 2ghz-* or 5ghz-* supported bands
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @returns {Map<string, string>} - Map of interface name to band ('2.4GHz' or '5GHz')
 */
async function getRadioBandMapping(mt, wifiPath) {
  const bandMap = new Map();

  try {
    // Query all radio info - this shows actual hardware capabilities
    const radioOutput = await mt.exec(`${wifiPath}/radio print detail without-paging`);

    // Split into entry blocks (each starts with a number)
    // Format: " 2   cap="name" radio-mac=...\n     bands=5ghz-...\n     interface=name ..."
    const entries = radioOutput.split(/\n(?=\s*\d+\s+)/);

    for (const entry of entries) {
      if (!entry.trim()) continue;

      // Look for interface= and bands= within the entry block
      const interfaceMatch = entry.match(/interface=([^\s]+)/);
      const bandsMatch = entry.match(/bands=([^\s]+)/);

      if (interfaceMatch && bandsMatch) {
        const ifaceName = interfaceMatch[1];
        const bands = bandsMatch[1].toLowerCase();

        if (bands.includes('2ghz')) {
          bandMap.set(ifaceName, '2.4GHz');
        } else if (bands.includes('5ghz')) {
          bandMap.set(ifaceName, '5GHz');
        }
      }
    }
  } catch (e) {
    // Radio query failed, caller will use fallback methods
  }

  return bandMap;
}

/**
 * Rename misnamed CAP interfaces to match their actual radio band
 * For devices with swapped radios, the -2g/-5g suffix doesn't match the actual band.
 * This function renames interfaces so the suffix correctly reflects the radio band.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @param {Array<{name: string, band: string}>} interfaces - Interfaces with detected bands
 * @returns {Array<{name: string, band: string}>} - Interfaces with corrected names
 */
async function renameCapInterfacesToMatchBand(mt, wifiPath, interfaces) {
  const correctedInterfaces = [];

  // Group interfaces by CAP identity to handle swaps together
  const byIdentity = new Map();
  for (const iface of interfaces) {
    const identity = iface.name.replace(/-2g$/, '').replace(/-5g$/, '');
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, []);
    }
    byIdentity.get(identity).push(iface);
  }

  for (const [identity, capInterfaces] of byIdentity) {
    // Check if any interface needs renaming
    const needsRenaming = capInterfaces.filter(iface => {
      const currentSuffix = iface.name.endsWith('-2g') ? '2g' : '5g';
      const correctSuffix = iface.band === '2.4GHz' ? '2g' : '5g';
      return currentSuffix !== correctSuffix;
    });

    if (needsRenaming.length === 0) {
      // No renaming needed, keep as-is
      correctedInterfaces.push(...capInterfaces);
      continue;
    }

    // For swapped devices, we need to swap both interface names
    // Use temp names to avoid conflicts
    console.log(`\n=== Renaming interfaces for ${identity} ===`);

    // Find the -2g and -5g interfaces
    const if2g = capInterfaces.find(i => i.name.endsWith('-2g'));
    const if5g = capInterfaces.find(i => i.name.endsWith('-5g'));

    if (if2g && if5g && needsRenaming.length === 2) {
      // Both need swapping - use temp name approach
      const name2g = `${identity}-2g`;
      const name5g = `${identity}-5g`;
      const tempName = `${identity}-swap-temp`;

      try {
        // Step 1: Rename -2g to temp
        await mt.exec(`${wifiPath} set [find name="${name2g}"] name="${tempName}"`);
        console.log(`  ✓ ${name2g} → ${tempName} (temp)`);

        // Step 2: Rename -5g to -2g
        await mt.exec(`${wifiPath} set [find name="${name5g}"] name="${name2g}"`);
        console.log(`  ✓ ${name5g} → ${name2g}`);

        // Step 3: Rename temp to -5g
        await mt.exec(`${wifiPath} set [find name="${tempName}"] name="${name5g}"`);
        console.log(`  ✓ ${tempName} → ${name5g}`);

        // Update the interface objects with new names (swapped)
        correctedInterfaces.push({ name: name2g, band: if5g.band }); // Was -5g, now -2g
        correctedInterfaces.push({ name: name5g, band: if2g.band }); // Was -2g, now -5g
      } catch (e) {
        console.log(`  ⚠️  Rename failed: ${e.message}`);
        // Keep original names on failure
        correctedInterfaces.push(...capInterfaces);
      }
    } else {
      // Single interface or partial rename (shouldn't happen normally)
      for (const iface of capInterfaces) {
        const currentSuffix = iface.name.endsWith('-2g') ? '2g' : '5g';
        const correctSuffix = iface.band === '2.4GHz' ? '2g' : '5g';

        if (currentSuffix !== correctSuffix) {
          const newName = `${identity}-${correctSuffix}`;
          try {
            await mt.exec(`${wifiPath} set [find name="${iface.name}"] name="${newName}"`);
            console.log(`  ✓ ${iface.name} → ${newName}`);
            correctedInterfaces.push({ name: newName, band: iface.band });
          } catch (e) {
            console.log(`  ⚠️  Rename ${iface.name} failed: ${e.message}`);
            correctedInterfaces.push(iface);
          }
        } else {
          correctedInterfaces.push(iface);
        }
      }
    }
  }

  return correctedInterfaces;
}

/**
 * Discover CAP-operated interfaces on a CAPsMAN controller
 * For wifi-qcom, these interfaces appear after CAPs connect with naming like:
 * - "<cap-identity>-2g" for 2.4GHz
 * - "<cap-identity>-5g" for 5GHz
 *
 * IMPORTANT: The interface naming (-2g/-5g) comes from MikroTik's CAPsMAN and
 * represents the physical interface number, NOT the actual radio band. Some devices
 * like cAP ax have swapped radios where wifi1 is actually 5GHz.
 *
 * This function:
 * 1. Detects actual radio bands via hardware query
 * 2. Renames misnamed interfaces to match actual bands
 * 3. Returns interfaces with correct names
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path (/interface/wifi or /interface/wifiwave2)
 * @param {string} wifiPackage - WiFi package type (wifi-qcom or wifiwave2)
 * @returns {Array<{name: string, band: string}>} - List of CAP interfaces with correct names
 */
async function discoverCapInterfaces(mt, wifiPath, wifiPackage) {
  const capInterfaces = [];

  try {
    // Method 1: Get actual bands from radio hardware (most reliable)
    const radioBandMap = await getRadioBandMapping(mt, wifiPath);

    // Method 2: Get list of CAPs with swapped radios based on board type (fallback)
    const swappedCaps = await getSwappedRadioCaps(mt, wifiPackage);

    // List all WiFi interfaces
    const output = await mt.exec(`${wifiPath} print terse without-paging`);

    // Parse each line for CAP interface names
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      // Extract interface name
      const nameMatch = line.match(/name="?([^"\s]+)"?/);
      if (!nameMatch) continue;

      const name = nameMatch[1];

      // Skip local interfaces (wifi1, wifi2, wifi1-ssid2, etc.)
      if (/^wifi\d/.test(name)) continue;

      // CAP interfaces end with -2g or -5g (master interfaces only, not virtuals)
      if (!name.endsWith('-2g') && !name.endsWith('-5g')) continue;

      let band = null;
      let detectionMethod = null;

      // Method 1: Use radio hardware band detection (most reliable)
      if (radioBandMap.has(name)) {
        band = radioBandMap.get(name);
        detectionMethod = 'radio hardware';
      }

      // Method 2: Check if device has swapped radios based on board type
      if (!band) {
        const capIdentity = name.replace(/-2g$/, '').replace(/-5g$/, '');
        const isSwappedDevice = swappedCaps.has(capIdentity);
        const suffix = name.endsWith('-2g') ? '2g' : '5g';

        if (isSwappedDevice) {
          // Swapped radios: -2g suffix is actually 5GHz, -5g suffix is actually 2.4GHz
          band = suffix === '2g' ? '5GHz' : '2.4GHz';
          detectionMethod = 'board type (swapped)';
        } else {
          // Method 3: Use interface name suffix (fallback, may be wrong)
          band = suffix === '2g' ? '2.4GHz' : '5GHz';
          detectionMethod = 'interface name';
        }
      }

      // Log misnamed interfaces
      const nameSuggestsBand = name.endsWith('-2g') ? '2.4GHz' : '5GHz';
      if (band !== nameSuggestsBand) {
        console.log(`ℹ️  ${name}: Actual band is ${band} (via ${detectionMethod}) - will rename`);
      }

      if (band) {
        capInterfaces.push({ name, band });
      }
    }

    // Rename misnamed interfaces to match actual bands
    if (capInterfaces.length > 0) {
      const correctedInterfaces = await renameCapInterfacesToMatchBand(mt, wifiPath, capInterfaces);
      return correctedInterfaces;
    }
  } catch (e) {
    console.log(`⚠️  Could not discover CAP interfaces: ${e.message}`);
  }

  return capInterfaces;
}

module.exports = {
  detectRadioLayout,
  applyBandSettings,
  configureWifiInterface,
  getSwappedRadioCaps,
  getRadioBandMapping,
  renameCapInterfacesToMatchBand,
  discoverCapInterfaces
};
