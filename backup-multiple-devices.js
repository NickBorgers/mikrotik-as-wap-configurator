#!/usr/bin/env node

const fs = require('fs');
const yaml = require('js-yaml');
const { backupMikroTikConfig } = require('./mikrotik-no-vlan-filtering.js');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node backup-multiple-devices.js <devices-file.yaml> [--output output-file.yaml]');
    console.log('');
    console.log('Examples:');
    console.log('  # Update file in-place (default)');
    console.log('  node backup-multiple-devices.js multiple-devices.yaml');
    console.log('');
    console.log('  # Save to different file');
    console.log('  node backup-multiple-devices.js multiple-devices.yaml --output backup.yaml');
    console.log('');
    console.log('Input file should contain a list of devices with credentials:');
    console.log('');
    console.log('devices:');
    console.log('  - host: 192.168.88.1');
    console.log('    username: admin');
    console.log('    password: password');
    console.log('  - host: 192.168.88.2');
    console.log('    username: admin');
    console.log('    password: password');
    console.log('');
    console.log('This tool connects to each device and exports configurations,');
    console.log('updating the file in-place with full device configurations.');
    console.log('');
    console.log('Workflow:');
    console.log('  1. Create file with just device credentials');
    console.log('  2. Run backup to populate with full configs');
    console.log('  3. Edit configs as needed');
    console.log('  4. Apply with apply-multiple-devices.js');
    process.exit(1);
  }

  const inputFile = args[0];

  // Check for --output flag
  let outputFile = inputFile; // Default: update in-place
  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    outputFile = args[outputIndex + 1];
  }

  console.log('=== MikroTik Multi-Device Backup ===');
  console.log(`Input file: ${inputFile}`);
  if (outputFile === inputFile) {
    console.log(`Mode: Update in-place`);
  } else {
    console.log(`Output file: ${outputFile}`);
  }
  console.log('');

  // Load device list
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
  console.log(`Found ${devices.length} device(s) to backup\n`);

  const results = {
    devices: []
  };

  let successCount = 0;
  let failureCount = 0;

  // Backup each device
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];

    // Support both simple format (just credentials) and full format (with device object)
    let host, username, password;
    if (device.device) {
      // Full format: { device: { host, username, password }, managementInterfaces, ssids, ... }
      host = device.device.host;
      username = device.device.username;
      password = device.device.password;
    } else {
      // Simple format: { host, username, password }
      host = device.host;
      username = device.username;
      password = device.password;
    }

    if (!host || !username || !password) {
      console.log(`\n[${i + 1}/${devices.length}] Skipping device - missing credentials`);
      failureCount++;
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${i + 1}/${devices.length}] Backing up device: ${host}`);
    console.log(`${'='.repeat(60)}`);

    try {
      const config = await backupMikroTikConfig({ host, username, password });

      results.devices.push(config);
      successCount++;

      console.log(`\n✓ Successfully backed up ${host}`);
      console.log(`  SSIDs: ${config.ssids.length}`);
      console.log(`  Management interfaces: ${config.managementInterfaces.join(', ')}`);
      console.log(`  Disabled interfaces: ${config.disabledInterfaces.length > 0 ? config.disabledInterfaces.join(', ') : 'none'}`);
      if (config.wifi) {
        console.log(`  WiFi optimization: configured (${Object.keys(config.wifi).join(', ')})`);
      }

    } catch (error) {
      console.error(`\n✗ Failed to backup ${host}: ${error.message}`);
      failureCount++;

      // Add placeholder with error
      results.devices.push({
        device: {
          host,
          username,
          password
        },
        _backup_error: error.message,
        managementInterfaces: ['ether1'],
        disabledInterfaces: [],
        ssids: []
      });
    }
  }

  // Write results to file
  console.log(`\n${'='.repeat(60)}`);
  console.log('Writing backup file...');
  console.log(`${'='.repeat(60)}\n`);

  const header = `# MikroTik Multi-Device Configuration
# Last updated: ${new Date().toISOString()}
# Devices: ${devices.length} (Successful: ${successCount}, Failed: ${failureCount})

`;

  const yamlContent = yaml.dump(results, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false
  });

  const finalContent = header + yamlContent;

  try {
    fs.writeFileSync(outputFile, finalContent, 'utf8');
    if (outputFile === inputFile) {
      console.log(`✓ Configuration updated in: ${outputFile}\n`);
    } else {
      console.log(`✓ Backup saved to: ${outputFile}\n`);
    }
  } catch (e) {
    console.error(`✗ Error writing output file: ${e.message}`);
    process.exit(1);
  }

  // Summary
  console.log('=== Backup Summary ===');
  console.log(`Total devices: ${devices.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failureCount}`);
  console.log('');

  if (successCount > 0) {
    // Check if any passphrases are UNKNOWN
    const hasUnknown = results.devices.some(device =>
      device.ssids && device.ssids.some(ssid => ssid.passphrase === 'UNKNOWN')
    );

    if (hasUnknown) {
      console.log('⚠️  IMPORTANT: Some passphrases are marked as UNKNOWN because MikroTik');
      console.log('   does not expose them via SSH. You MUST edit the file and');
      console.log('   replace UNKNOWN with real passphrases before applying.');
      console.log('');
    }

    console.log('You can now use this file with apply-multiple-devices.js:');
    console.log(`  ./apply-multiple-devices.js ${outputFile}`);
  }

  if (failureCount > 0) {
    process.exit(1);
  }
}

main();
