#!/usr/bin/env node

const { MikroTikSSH } = require('./mikrotik-no-vlan-filtering.js');
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

    console.log('\n=== All WiFi Interfaces (verbose) ===');
    const all = await mt.exec('/interface/wifi print');
    console.log(all);

    console.log('\n=== Virtual WiFi Interfaces ===');
    const virtuals = await mt.exec('/interface/wifi print where master-interface');
    console.log(virtuals || '(none found)');

    await mt.close();
  } catch (error) {
    console.error('Error:', error.message);
    await mt.close();
    process.exit(1);
  }
}

checkDevice();
