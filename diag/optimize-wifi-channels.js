#!/usr/bin/env node

/**
 * WiFi Channel Optimization Script
 *
 * Analyzes multiple MikroTik devices and suggests optimal channel configurations
 * to minimize interference between physically close access points.
 *
 * Usage:
 *   node optimize-wifi-channels.js <devices-file.yaml>
 *   node optimize-wifi-channels.js <devices-file.yaml> --apply
 *   node optimize-wifi-channels.js <devices-file.yaml> --apply --output optimized.yaml
 *
 * Modes:
 *   - Default: Analyzes and displays suggestions (dry-run)
 *   - --apply: Updates the YAML file with suggested channels
 *   - --output: Saves to a different file (requires --apply)
 */

const fs = require('fs');
const yaml = require('js-yaml');
const { MikroTikSSH } = require('../mikrotik-no-vlan-filtering.js');

// Optimal non-overlapping channels
const OPTIMAL_CHANNELS = {
  '2.4GHz': [1, 6, 11],  // Standard non-overlapping channels
  '5GHz': [36, 52, 149]  // Common non-overlapping channels (some regions may vary)
};

// Additional 5GHz channels if more than 3 devices
const ADDITIONAL_5GHZ = [40, 44, 48, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 153, 157, 161, 165];

async function getCurrentWiFiSettings(host, username, password) {
  const mt = new MikroTikSSH(host, username, password);

  try {
    await mt.connect();

    const settings = {
      '2.4GHz': {},
      '5GHz': {}
    };

    // Read 2.4GHz (wifi1)
    try {
      const wifi1Output = await mt.exec('/interface wifi print detail without-paging where default-name=wifi1');
      const channelMatch = wifi1Output.match(/configuration\.channel\.frequency=(\d+)/);
      const txPowerMatch = wifi1Output.match(/configuration\.tx-power=(\d+)/);
      const countryMatch = wifi1Output.match(/configuration\.country="?([^"\s]+)"?/);

      if (channelMatch) {
        const freq = parseInt(channelMatch[1]);
        // Map frequency to channel
        const freqChannelMap = {
          2412: 1, 2417: 2, 2422: 3, 2427: 4, 2432: 5, 2437: 6,
          2442: 7, 2447: 8, 2452: 9, 2457: 10, 2462: 11, 2467: 12, 2472: 13
        };
        settings['2.4GHz'].channel = freqChannelMap[freq] || null;
        settings['2.4GHz'].frequency = freq;
      }

      if (txPowerMatch) {
        settings['2.4GHz'].txPower = parseInt(txPowerMatch[1]);
      }

      if (countryMatch) {
        settings['2.4GHz'].country = countryMatch[1];
      }
    } catch (e) {
      console.log(`  ⚠️  Could not read 2.4GHz settings: ${e.message}`);
    }

    // Read 5GHz (wifi2)
    try {
      const wifi2Output = await mt.exec('/interface wifi print detail without-paging where default-name=wifi2');
      const channelMatch = wifi2Output.match(/configuration\.channel\.frequency=(\d+)/);
      const txPowerMatch = wifi2Output.match(/configuration\.tx-power=(\d+)/);
      const countryMatch = wifi2Output.match(/configuration\.country="?([^"\s]+)"?/);

      if (channelMatch) {
        const freq = parseInt(channelMatch[1]);
        // Map frequency to channel for 5GHz
        const freqChannelMap = {
          5180: 36, 5200: 40, 5220: 44, 5240: 48,
          5260: 52, 5280: 56, 5300: 60, 5320: 64,
          5500: 100, 5520: 104, 5540: 108, 5560: 112, 5580: 116, 5600: 120, 5620: 124, 5640: 128,
          5660: 132, 5680: 136, 5700: 140, 5720: 144,
          5745: 149, 5765: 153, 5785: 157, 5805: 161, 5825: 165
        };
        settings['5GHz'].channel = freqChannelMap[freq] || null;
        settings['5GHz'].frequency = freq;
      }

      if (txPowerMatch) {
        settings['5GHz'].txPower = parseInt(txPowerMatch[1]);
      }

      if (countryMatch) {
        settings['5GHz'].country = countryMatch[1];
      }
    } catch (e) {
      console.log(`  ⚠️  Could not read 5GHz settings: ${e.message}`);
    }

    await mt.close();
    return settings;

  } catch (error) {
    await mt.close();
    throw error;
  }
}

function suggestOptimalChannels(deviceCount, currentSettings) {
  const suggestions = {
    '2.4GHz': [],
    '5GHz': []
  };

  // For 2.4GHz, use the 3 non-overlapping channels (1, 6, 11)
  // If more than 3 devices, reuse channels with spacing
  for (let i = 0; i < deviceCount; i++) {
    suggestions['2.4GHz'].push(OPTIMAL_CHANNELS['2.4GHz'][i % 3]);
  }

  // For 5GHz, use optimal channels plus additional ones if needed
  const available5GHz = [...OPTIMAL_CHANNELS['5GHz']];
  if (deviceCount > 3) {
    available5GHz.push(...ADDITIONAL_5GHZ.slice(0, deviceCount - 3));
  }

  for (let i = 0; i < deviceCount; i++) {
    suggestions['5GHz'].push(available5GHz[i % available5GHz.length]);
  }

  return suggestions;
}

function analyzeChannelConflicts(devices) {
  const conflicts = {
    '2.4GHz': {},
    '5GHz': {}
  };

  devices.forEach(device => {
    ['2.4GHz', '5GHz'].forEach(band => {
      const channel = device.currentSettings?.[band]?.channel;
      if (channel) {
        if (!conflicts[band][channel]) {
          conflicts[band][channel] = [];
        }
        conflicts[band][channel].push(device.host);
      }
    });
  });

  // Return only channels with conflicts (multiple devices)
  const result = {
    '2.4GHz': {},
    '5GHz': {}
  };

  ['2.4GHz', '5GHz'].forEach(band => {
    Object.keys(conflicts[band]).forEach(channel => {
      if (conflicts[band][channel].length > 1) {
        result[band][channel] = conflicts[band][channel];
      }
    });
  });

  return result;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node optimize-wifi-channels.js <devices-file.yaml> [--apply] [--output output.yaml]');
    console.log('');
    console.log('Examples:');
    console.log('  # Analyze and show suggestions (dry-run)');
    console.log('  node optimize-wifi-channels.js multiple-devices.yaml');
    console.log('');
    console.log('  # Apply suggestions and update file in-place');
    console.log('  node optimize-wifi-channels.js multiple-devices.yaml --apply');
    console.log('');
    console.log('  # Apply suggestions and save to different file');
    console.log('  node optimize-wifi-channels.js multiple-devices.yaml --apply --output optimized.yaml');
    console.log('');
    console.log('This tool analyzes channel usage across multiple devices and suggests');
    console.log('optimal non-overlapping channels to minimize interference.');
    console.log('');
    console.log('For 3 devices:');
    console.log('  2.4GHz: Channels 1, 6, 11 (non-overlapping)');
    console.log('  5GHz: Channels 36, 52, 149 (well-separated)');
    process.exit(1);
  }

  const inputFile = args[0];
  const applyChanges = args.includes('--apply');

  let outputFile = inputFile; // Default: update in-place
  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    outputFile = args[outputIndex + 1];
  }

  if (outputFile !== inputFile && !applyChanges) {
    console.error('✗ --output requires --apply flag');
    process.exit(1);
  }

  console.log('=== WiFi Channel Optimization Tool ===');
  console.log(`Input file: ${inputFile}`);
  if (applyChanges) {
    console.log(`Mode: Apply changes`);
    console.log(`Output file: ${outputFile}`);
  } else {
    console.log(`Mode: Analyze only (dry-run)`);
  }
  console.log('');

  // Load devices
  let devicesData;
  try {
    const fileContents = fs.readFileSync(inputFile, 'utf8');
    devicesData = yaml.load(fileContents);
  } catch (e) {
    console.error(`✗ Error loading input file: ${e.message}`);
    process.exit(1);
  }

  if (!devicesData.devices || !Array.isArray(devicesData.devices)) {
    console.error('✗ Input file must contain a "devices" array');
    process.exit(1);
  }

  const devices = devicesData.devices;
  console.log(`Found ${devices.length} device(s)\n`);

  // Collect current settings from each device
  const deviceInfo = [];

  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const host = device.device?.host || device.host;
    const username = device.device?.username || device.username;
    const password = device.device?.password || device.password;

    if (!host || !username || !password) {
      console.log(`[${i + 1}/${devices.length}] Skipping ${host || 'unknown'} - missing credentials`);
      continue;
    }

    console.log(`[${i + 1}/${devices.length}] Analyzing ${host}...`);

    try {
      const currentSettings = await getCurrentWiFiSettings(host, username, password);

      deviceInfo.push({
        index: i,
        host,
        currentSettings,
        device
      });

      console.log(`  2.4GHz: ${currentSettings['2.4GHz'].channel ? `Channel ${currentSettings['2.4GHz'].channel}` : 'Not configured'}`);
      console.log(`  5GHz: ${currentSettings['5GHz'].channel ? `Channel ${currentSettings['5GHz'].channel}` : 'Not configured'}`);

    } catch (error) {
      console.error(`  ✗ Failed to connect: ${error.message}`);
      deviceInfo.push({
        index: i,
        host,
        currentSettings: null,
        device,
        error: error.message
      });
    }
  }

  console.log('');

  // Analyze conflicts
  const conflicts = analyzeChannelConflicts(deviceInfo);
  const hasConflicts = Object.keys(conflicts['2.4GHz']).length > 0 || Object.keys(conflicts['5GHz']).length > 0;

  if (hasConflicts) {
    console.log('=== Channel Conflicts Detected ===');

    if (Object.keys(conflicts['2.4GHz']).length > 0) {
      console.log('\n2.4GHz conflicts:');
      Object.keys(conflicts['2.4GHz']).forEach(channel => {
        const hosts = conflicts['2.4GHz'][channel];
        console.log(`  Channel ${channel}: ${hosts.join(', ')} (${hosts.length} devices)`);
      });
    }

    if (Object.keys(conflicts['5GHz']).length > 0) {
      console.log('\n5GHz conflicts:');
      Object.keys(conflicts['5GHz']).forEach(channel => {
        const hosts = conflicts['5GHz'][channel];
        console.log(`  Channel ${channel}: ${hosts.join(', ')} (${hosts.length} devices)`);
      });
    }
    console.log('');
  } else {
    console.log('=== No Channel Conflicts Detected ===\n');
  }

  // Generate suggestions
  const suggestions = suggestOptimalChannels(deviceInfo.length, deviceInfo.map(d => d.currentSettings));

  console.log('=== Suggested Channel Configuration ===\n');

  deviceInfo.forEach((info, idx) => {
    console.log(`Device ${idx + 1}: ${info.host}`);
    console.log(`  2.4GHz: Channel ${suggestions['2.4GHz'][idx]} (${info.currentSettings?.['2.4GHz']?.channel ? `currently ${info.currentSettings['2.4GHz'].channel}` : 'not configured'})`);
    console.log(`  5GHz: Channel ${suggestions['5GHz'][idx]} (${info.currentSettings?.['5GHz']?.channel ? `currently ${info.currentSettings['5GHz'].channel}` : 'not configured'})`);
  });

  console.log('');

  // Apply changes if requested
  if (applyChanges) {
    console.log('=== Applying Suggestions ===\n');

    deviceInfo.forEach((info, idx) => {
      const device = info.device;

      // Initialize wifi section if it doesn't exist
      if (!device.wifi) {
        device.wifi = {};
      }

      // Apply suggested channels
      if (!device.wifi['2.4GHz']) {
        device.wifi['2.4GHz'] = {};
      }
      device.wifi['2.4GHz'].channel = suggestions['2.4GHz'][idx];

      if (!device.wifi['5GHz']) {
        device.wifi['5GHz'] = {};
      }
      device.wifi['5GHz'].channel = suggestions['5GHz'][idx];

      // Preserve existing settings (txPower, country)
      if (info.currentSettings?.['2.4GHz']?.txPower && !device.wifi['2.4GHz'].txPower) {
        device.wifi['2.4GHz'].txPower = info.currentSettings['2.4GHz'].txPower;
      }
      if (info.currentSettings?.['2.4GHz']?.country && !device.wifi['2.4GHz'].country) {
        device.wifi['2.4GHz'].country = info.currentSettings['2.4GHz'].country;
      }

      if (info.currentSettings?.['5GHz']?.txPower && !device.wifi['5GHz'].txPower) {
        device.wifi['5GHz'].txPower = info.currentSettings['5GHz'].txPower;
      }
      if (info.currentSettings?.['5GHz']?.country && !device.wifi['5GHz'].country) {
        device.wifi['5GHz'].country = info.currentSettings['5GHz'].country;
      }

      console.log(`✓ Updated ${info.host} with suggested channels`);
    });

    // Write to file
    const header = `# MikroTik Multi-Device Configuration
# Optimized by WiFi Channel Optimization Tool
# Last updated: ${new Date().toISOString()}
# Devices: ${devices.length}

`;

    const yamlContent = yaml.dump(devicesData, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false
    });

    const finalContent = header + yamlContent;

    try {
      fs.writeFileSync(outputFile, finalContent, 'utf8');
      console.log(`\n✓ Configuration saved to: ${outputFile}`);
      console.log('\nNext steps:');
      console.log(`  1. Review the updated configuration: ${outputFile}`);
      console.log(`  2. Apply to devices: ./apply-multiple-devices.js ${outputFile}`);
    } catch (e) {
      console.error(`\n✗ Error writing output file: ${e.message}`);
      process.exit(1);
    }

  } else {
    console.log('=== Dry Run Complete ===');
    console.log('\nNo changes were made to the configuration file.');
    console.log('To apply these suggestions, run with --apply flag:');
    console.log(`  node optimize-wifi-channels.js ${inputFile} --apply`);
  }
}

main().catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
