#!/usr/bin/env node

const fs = require('fs');
const yaml = require('js-yaml');
const { backupMikroTikConfig } = require('./mikrotik-no-vlan-filtering.js');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node backup-config.js <host> <username> <password> [output-file]');
    console.log('');
    console.log('Examples:');
    console.log('  node backup-config.js 192.168.88.1 admin mypassword');
    console.log('  node backup-config.js 192.168.88.1 admin mypassword backup.yaml');
    console.log('  node backup-config.js 10.212.254.51 admin DQ45LVEQRZ config.yaml');
    console.log('');
    console.log('This tool connects to a MikroTik device and exports the current');
    console.log('configuration to a YAML file compatible with apply-config.js');
    console.log('');
    console.log('If output-file is not specified, outputs to config-backup.yaml');
    process.exit(1);
  }

  const host = args[0];
  const username = args[1];
  const password = args[2];
  const outputFile = args[3] || 'config-backup.yaml';

  console.log('=== MikroTik Configuration Backup ===');
  console.log(`Target device: ${host}`);
  console.log(`Username: ${username}`);
  console.log(`Output file: ${outputFile}`);
  console.log('');

  try {
    const config = await backupMikroTikConfig({ host, username, password });

    // Convert to YAML
    const yamlContent = yaml.dump(config, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false
    });

    // Add header comment
    const header = `# MikroTik Network Configuration Backup
# Generated on ${new Date().toISOString()}
# Source device: ${host}

`;

    const finalContent = header + yamlContent;

    // Write to file
    fs.writeFileSync(outputFile, finalContent, 'utf8');

    console.log(`\n✓ Configuration backed up to: ${outputFile}`);
    console.log('\nConfiguration summary:');
    console.log(`  Management interfaces: ${config.managementInterfaces.join(', ')}`);
    console.log(`  Disabled interfaces: ${config.disabledInterfaces.length > 0 ? config.disabledInterfaces.join(', ') : 'none'}`);

    if (config.wifi) {
      console.log(`  WiFi optimization: enabled`);
      if (config.wifi['2.4GHz']) {
        const c = config.wifi['2.4GHz'];
        console.log(`    2.4GHz: ${c.channel ? `ch ${c.channel}` : ''} ${c.txPower ? `${c.txPower}dBm` : ''} ${c.country ? c.country : ''}`.trim());
      }
      if (config.wifi['5GHz']) {
        const c = config.wifi['5GHz'];
        console.log(`    5GHz: ${c.channel ? `ch ${c.channel}` : ''} ${c.txPower ? `${c.txPower}dBm` : ''} ${c.country ? c.country : ''}`.trim());
      }
    }

    console.log(`  SSIDs configured: ${config.ssids.length}`);

    if (config.ssids.length > 0) {
      console.log('\nSSIDs:');
      config.ssids.forEach(ssid => {
        console.log(`  - ${ssid.ssid}`);
        console.log(`    Bands: ${ssid.bands.join(', ')}`);
        console.log(`    VLAN: ${ssid.vlan}`);
      });
    }

    // Check if any passphrases are UNKNOWN
    const hasUnknown = config.ssids.some(ssid => ssid.passphrase === 'UNKNOWN');

    if (hasUnknown) {
      console.log('\n⚠️  IMPORTANT: Some passphrases are marked as UNKNOWN because MikroTik');
      console.log('   does not expose them via SSH. You MUST edit the file and');
      console.log('   replace UNKNOWN with real passphrases before applying.');
      console.log('');
    }

    console.log('You can now use this file with apply-config.js:');
    console.log(`  ./apply-config.js ${outputFile}`);

  } catch (error) {
    console.error('\n✗ Backup failed:', error.message);
    process.exit(1);
  }
}

main();
