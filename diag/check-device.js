#!/usr/bin/env node

const { MikroTikSSH } = require('../mikrotik-no-vlan-filtering.js');
const yaml = require('js-yaml');
const fs = require('fs');

async function checkDevice() {
  const config = yaml.load(fs.readFileSync('prod.yaml', 'utf8'));

  const mt = new MikroTikSSH(
    config.device.host,
    config.device.username,
    config.device.password
  );

  try {
    await mt.connect();

    console.log('\n=== WiFi Interfaces ===');
    const interfaces = await mt.exec('/interface/wifi print detail');
    console.log(interfaces);

    console.log('\n=== WiFi Datapaths ===');
    const datapaths = await mt.exec('/interface/wifi/datapath print detail');
    console.log(datapaths);

    await mt.close();
  } catch (error) {
    console.error('Error:', error.message);
    await mt.close();
    process.exit(1);
  }
}

checkDevice();
