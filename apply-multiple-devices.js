#!/usr/bin/env node

const fs = require('fs');
const yaml = require('js-yaml');
const { configureMikroTik } = require('./mikrotik-no-vlan-filtering.js');

function loadConfig(configFile) {
  try {
    const fileContents = fs.readFileSync(configFile, 'utf8');
    const config = yaml.load(fileContents);
    return config;
  } catch (e) {
    console.error(`Error loading config file: ${e.message}`);
    process.exit(1);
  }
}

function validateDeviceConfig(config, index) {
  const errors = [];

  if (!config.device) {
    errors.push(`Device ${index}: Missing device configuration`);
  } else {
    if (!config.device.host) errors.push(`Device ${index}: Missing device.host`);
    if (!config.device.username) errors.push(`Device ${index}: Missing device.username`);
    if (!config.device.password) errors.push(`Device ${index}: Missing device.password`);
  }

  if (!config.ssids || config.ssids.length === 0) {
    errors.push(`Device ${index}: No SSIDs defined`);
  }

  if (config.ssids) {
    config.ssids.forEach((ssid, ssidIndex) => {
      if (!ssid.ssid) errors.push(`Device ${index}, SSID ${ssidIndex}: missing ssid`);
      if (!ssid.passphrase) errors.push(`Device ${index}, SSID ${ssidIndex}: missing passphrase`);
      if (ssid.passphrase === 'UNKNOWN') {
        errors.push(`Device ${index}, SSID ${ssidIndex} (${ssid.ssid}): passphrase is UNKNOWN - please set a real passphrase. UNKNOWN is used in backups when passphrases cannot be retrieved from devices.`);
      }
      if (ssid.vlan === undefined) errors.push(`Device ${index}, SSID ${ssidIndex}: missing vlan`);
      if (!ssid.bands || ssid.bands.length === 0) {
        errors.push(`Device ${index}, SSID ${ssidIndex}: missing bands`);
      }
      if (ssid.bands) {
        ssid.bands.forEach(band => {
          if (band !== '2.4GHz' && band !== '5GHz') {
            errors.push(`Device ${index}, SSID ${ssidIndex}: invalid band '${band}'`);
          }
        });
      }
    });
  }

  return errors;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node apply-multiple-devices.js <config-file.yaml> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --parallel    Apply configurations in parallel (faster but less readable output)');
    console.log('  --sequential  Apply configurations sequentially (default, clearer output)');
    console.log('');
    console.log('Examples:');
    console.log('  node apply-multiple-devices.js multiple-devices.yaml');
    console.log('  node apply-multiple-devices.js multiple-devices.yaml --parallel');
    console.log('');
    console.log('The config file should contain a "devices" array with device configurations.');
    console.log('Use backup-multiple-devices.js to generate this file from existing devices.');
    process.exit(1);
  }

  const configFile = args[0];
  const parallel = args.includes('--parallel');

  console.log('=== MikroTik Multi-Device Configuration ===');
  console.log(`Config file: ${configFile}`);
  console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}`);
  console.log('');

  console.log(`Loading configuration from: ${configFile}`);
  const config = loadConfig(configFile);

  if (!config.devices || !Array.isArray(config.devices)) {
    console.error('✗ Config file must contain a "devices" array');
    process.exit(1);
  }

  const devices = config.devices;
  console.log(`Found ${devices.length} device(s) to configure\n`);

  // Validate all devices first
  console.log('Validating configurations...');
  let hasValidationErrors = false;

  for (let i = 0; i < devices.length; i++) {
    const errors = validateDeviceConfig(devices[i], i + 1);
    if (errors.length > 0) {
      console.error(`\nValidation errors for device ${i + 1}:`);
      errors.forEach(err => console.error(`  - ${err}`));
      hasValidationErrors = true;
    }
  }

  if (hasValidationErrors) {
    console.error('\n✗ Configuration validation failed');
    process.exit(1);
  }

  console.log('✓ All configurations valid\n');

  // Apply configurations
  const results = [];

  if (parallel) {
    console.log('Applying configurations in parallel...\n');

    const promises = devices.map(async (deviceConfig, index) => {
      const mtConfig = {
        host: deviceConfig.device.host,
        username: deviceConfig.device.username,
        password: deviceConfig.device.password,
        managementInterfaces: deviceConfig.managementInterfaces || ['ether1'],
        disabledInterfaces: deviceConfig.disabledInterfaces || [],
        ssids: deviceConfig.ssids
      };

      try {
        await configureMikroTik(mtConfig);
        return { index: index + 1, host: mtConfig.host, success: true };
      } catch (error) {
        return { index: index + 1, host: mtConfig.host, success: false, error: error.message };
      }
    });

    const allResults = await Promise.all(promises);
    results.push(...allResults);

  } else {
    console.log('Applying configurations sequentially...\n');

    for (let i = 0; i < devices.length; i++) {
      const deviceConfig = devices[i];
      const mtConfig = {
        host: deviceConfig.device.host,
        username: deviceConfig.device.username,
        password: deviceConfig.device.password,
        managementInterfaces: deviceConfig.managementInterfaces || ['ether1'],
        disabledInterfaces: deviceConfig.disabledInterfaces || [],
        ssids: deviceConfig.ssids
      };

      console.log(`\n${'='.repeat(60)}`);
      console.log(`[${i + 1}/${devices.length}] Configuring device: ${mtConfig.host}`);
      console.log(`${'='.repeat(60)}`);
      console.log(`SSIDs to configure: ${deviceConfig.ssids.length}`);
      deviceConfig.ssids.forEach(ssid => {
        console.log(`  - ${ssid.ssid} (VLAN ${ssid.vlan}, Bands: ${ssid.bands.join(', ')})`);
      });
      console.log('');

      try {
        await configureMikroTik(mtConfig);
        results.push({ index: i + 1, host: mtConfig.host, success: true });
        console.log(`\n✓ Successfully configured ${mtConfig.host}`);
      } catch (error) {
        results.push({ index: i + 1, host: mtConfig.host, success: false, error: error.message });
        console.error(`\n✗ Failed to configure ${mtConfig.host}: ${error.message}`);
      }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Configuration Summary');
  console.log(`${'='.repeat(60)}\n`);

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`Total devices: ${devices.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);

  if (successful.length > 0) {
    console.log('\n✓ Successfully configured:');
    successful.forEach(r => console.log(`  - Device ${r.index}: ${r.host}`));
  }

  if (failed.length > 0) {
    console.log('\n✗ Failed to configure:');
    failed.forEach(r => console.log(`  - Device ${r.index}: ${r.host} - ${r.error}`));
    process.exit(1);
  }

  console.log('\n✓ All devices configured successfully!');
}

main();
