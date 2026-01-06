#!/usr/bin/env node

const { MikroTikSSH } = require('../mikrotik-no-vlan-filtering.js');

async function rawWiFiCheck(host, username, password) {
  const mt = new MikroTikSSH(host, username, password);

  try {
    await mt.connect();

    console.log('\n=== RAW WiFi Interface Output ===\n');
    const output = await mt.exec('/interface wifi print detail without-paging');
    console.log(output);

    console.log('\n=== WiFi Interface Status (terse) ===\n');
    const terse = await mt.exec('/interface wifi print terse');
    console.log(terse);

    console.log('\n=== Checking wifi2 specifically ===\n');
    const wifi2 = await mt.exec('/interface wifi print detail without-paging where default-name=wifi2');
    console.log(wifi2);

    await mt.close();
  } catch (error) {
    console.error('Error:', error.message);
    await mt.close();
    throw error;
  }
}

const [host, username, password] = process.argv.slice(2);
if (!host || !username || !password) {
  console.log('Usage: raw-wifi-check.js <host> <username> <password>');
  process.exit(1);
}

rawWiFiCheck(host, username, password).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
