#!/usr/bin/env node

/**
 * Check WiFi Interface Status
 * Shows enabled/disabled status and configuration for all WiFi interfaces
 */

const { MikroTikSSH } = require('../mikrotik-no-vlan-filtering.js');

async function checkWiFiStatus(host, username, password) {
  const mt = new MikroTikSSH(host, username, password);

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('WiFi Interface Status Check');
    console.log(`Device: ${host}`);
    console.log('========================================\n');

    const wifiOutput = await mt.exec('/interface wifi print detail without-paging');
    const lines = wifiOutput.split('\n');

    let currentInterface = null;
    const interfaces = [];

    for (const line of lines) {
      if (line.match(/^\s*\d+\s+/)) {
        if (currentInterface) {
          interfaces.push(currentInterface);
        }
        currentInterface = { raw: line };
      } else if (currentInterface && line.trim()) {
        currentInterface.raw += ' ' + line.trim();
      }
    }
    if (currentInterface) {
      interfaces.push(currentInterface);
    }

    console.log('=== WiFi Interfaces ===\n');

    for (const iface of interfaces) {
      const raw = iface.raw;

      // Extract details
      const nameMatch = raw.match(/name="?([^"\s]+)"?/);
      const defaultNameMatch = raw.match(/default-name="?([^"\s]+)"?/);
      const ssidMatch = raw.match(/(?:configuration)?\.ssid="([^"]+)"/);
      const datapathMatch = raw.match(/datapath="?([^"\s]+)"?/);
      const disabledMatch = raw.match(/disabled=yes/);
      const masterMatch = raw.match(/master-interface=([^\s]+)/);
      const flagsMatch = raw.match(/^\s*\d+\s+([A-Z]+)/);

      if (!nameMatch) continue;

      const name = nameMatch[1];
      const defaultName = defaultNameMatch ? defaultNameMatch[1] : null;
      const ssid = ssidMatch ? ssidMatch[1] : '(none)';
      const datapath = datapathMatch ? datapathMatch[1] : '(none)';
      const disabled = disabledMatch ? 'YES' : 'NO';
      const isMaster = !masterMatch;
      const flags = flagsMatch ? flagsMatch[1] : '';

      console.log(`Interface: ${name}${defaultName ? ` (${defaultName})` : ''}`);
      console.log(`  Type: ${isMaster ? 'Master' : 'Virtual'}`);
      console.log(`  Disabled: ${disabled}`);
      console.log(`  Flags: ${flags || '(none)'}`);
      console.log(`  SSID: ${ssid}`);
      console.log(`  Datapath: ${datapath}`);

      // Decode flags
      const flagMeanings = [];
      if (flags.includes('X')) flagMeanings.push('Disabled');
      if (flags.includes('R')) flagMeanings.push('Running');
      if (flags.includes('S')) flagMeanings.push('Slave');

      if (flagMeanings.length > 0) {
        console.log(`  Status: ${flagMeanings.join(', ')}`);
      }

      console.log('');
    }

    console.log('========================================\n');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    await mt.close();
    throw error;
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.log('Usage: check-wifi-status.js <host> <username> <password>');
    console.log('Example: check-wifi-status.js 192.168.88.1 admin password');
    process.exit(1);
  }

  const [host, username, password] = args;

  checkWiFiStatus(host, username, password)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { checkWiFiStatus };
