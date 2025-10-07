#!/usr/bin/env node

const { MikroTikSSH } = require('../mikrotik-no-vlan-filtering.js');

async function checkStatus(host, username, password) {
  const mt = new MikroTikSSH(host, username, password);

  try {
    await mt.connect();

    console.log('\n=== WiFi Interfaces ===');
    const wifi = await mt.exec('/interface/wifi print detail');
    console.log(wifi);

    console.log('\n=== WiFi Datapaths ===');
    const datapaths = await mt.exec('/interface/wifi/datapath print detail');
    console.log(datapaths);

    console.log('\n=== Bridge Ports ===');
    const bridge = await mt.exec('/interface/bridge/port print');
    console.log(bridge);

    await mt.close();
  } catch (e) {
    console.error('Error:', e.message);
    await mt.close();
    process.exit(1);
  }
}

if (require.main === module) {
  const [host, username, password] = process.argv.slice(2);

  if (!host || !username || !password) {
    console.log('Usage: node check-status.js <host> <username> <password>');
    console.log('Example: node check-status.js 192.168.88.1 admin admin');
    process.exit(1);
  }

  checkStatus(host, username, password);
}

module.exports = { checkStatus };
