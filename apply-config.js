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

function validateConfig(config) {
  const errors = [];

  if (!config.device) {
    errors.push('Missing device configuration');
  } else {
    if (!config.device.host) errors.push('Missing device.host');
    if (!config.device.username) errors.push('Missing device.username');
    if (!config.device.password) errors.push('Missing device.password');
  }

  if (!config.ssids || config.ssids.length === 0) {
    errors.push('No SSIDs defined');
  }

  if (config.ssids) {
    config.ssids.forEach((ssid, index) => {
      if (!ssid.ssid) errors.push(`SSID ${index}: missing ssid`);
      if (!ssid.passphrase) errors.push(`SSID ${index}: missing passphrase`);
      if (ssid.passphrase === 'UNKNOWN') {
        errors.push(`SSID ${index} (${ssid.ssid}): passphrase is UNKNOWN - please set a real passphrase. UNKNOWN is used in backups when passphrases cannot be retrieved from devices.`);
      }
      if (ssid.vlan === undefined) errors.push(`SSID ${index}: missing vlan`);
      if (!ssid.bands || ssid.bands.length === 0) {
        errors.push(`SSID ${index}: missing bands (must specify 2.4GHz, 5GHz, or both)`);
      }
      if (ssid.bands) {
        ssid.bands.forEach(band => {
          if (band !== '2.4GHz' && band !== '5GHz') {
            errors.push(`SSID ${index}: invalid band '${band}' (must be 2.4GHz or 5GHz)`);
          }
        });
      }
    });
  }

  if (errors.length > 0) {
    console.error('Configuration validation errors:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  return true;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node apply-config.js <config-file.yaml> [target-ip]');
    console.log('');
    console.log('Examples:');
    console.log('  node apply-config.js config.yaml');
    console.log('  node apply-config.js config.yaml 192.168.1.100');
    console.log('');
    console.log('The config file specifies SSIDs, VLANs, and security settings.');
    console.log('If target-ip is provided, it overrides the host in the config file.');
    process.exit(1);
  }

  const configFile = args[0];
  const targetIp = args[1];

  console.log(`Loading configuration from: ${configFile}`);
  const config = loadConfig(configFile);

  console.log('Validating configuration...');
  validateConfig(config);

  // Prepare configuration for MikroTik
  const mtConfig = {
    host: targetIp || config.device.host,
    username: config.device.username,
    password: config.device.password,
    identity: config.identity,  // Optional explicit identity override
    managementInterfaces: config.managementInterfaces || ['ether1'],
    disabledInterfaces: config.disabledInterfaces || [],
    wifi: config.wifi,  // WiFi optimization settings (channel, power, roaming)
    securityProfile: config.security?.profile || 'wpa2-vlan100',
    passphrase: config.security?.passphrase || 'password',
    ssids: config.ssids
  };

  console.log('\n=== Configuration Summary ===');
  console.log(`Target device: ${mtConfig.host}`);

  // Format management interfaces for display
  const mgmtDisplay = mtConfig.managementInterfaces.map(iface => {
    if (typeof iface === 'string') {
      return iface;
    } else if (iface.bond) {
      return `bond (${iface.bond.join('+')})`;
    }
    return 'unknown';
  });

  console.log(`Management interfaces: ${mgmtDisplay.join(', ')}`);
  console.log(`SSIDs to configure: ${config.ssids.length}`);
  config.ssids.forEach(ssid => {
    console.log(`  - ${ssid.ssid}`);
    console.log(`    Bands: ${ssid.bands.join(', ')}`);
    console.log(`    VLAN: ${ssid.vlan}`);
  });

  console.log('\n');
  console.log('Applying configuration to device...');
  console.log('');

  try {
    await configureMikroTik(mtConfig);
    console.log('\n✓ Configuration applied successfully!');
  } catch (error) {
    console.error('\n✗ Configuration failed:', error.message);
    process.exit(1);
  }
}

main();
