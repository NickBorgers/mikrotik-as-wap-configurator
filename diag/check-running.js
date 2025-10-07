#!/usr/bin/env node

const { MikroTikSSH } = require('../mikrotik-no-vlan-filtering.js');

async function checkRunning(host, username, password) {
  const mt = new MikroTikSSH(host, username, password);

  try {
    await mt.connect();

    console.log('=== WiFi Registration Table (Active Clients) ===');
    const reg = await mt.exec('/interface/wifi/registration-table print');
    console.log(reg || 'No clients connected');

    console.log('\n=== Interface Monitor Status ===');

    // Check master interfaces
    try {
      const mon1 = await mt.exec('/interface/wifi monitor [find default-name=wifi1] once');
      console.log('\nwifi1 (2.4GHz):');
      console.log(mon1);
    } catch(e) {
      console.log('\nwifi1 monitor error:', e.message);
    }

    try {
      const mon2 = await mt.exec('/interface/wifi monitor [find default-name=wifi2] once');
      console.log('\nwifi2 (5GHz):');
      console.log(mon2);
    } catch(e) {
      console.log('\nwifi2 monitor error:', e.message);
    }

    // Check virtual interfaces
    console.log('\n=== Virtual Interface Status ===');
    const interfaces = await mt.exec('/interface/wifi print terse where master-interface');

    if (interfaces && interfaces.trim()) {
      const lines = interfaces.trim().split('\n');
      for (const line of lines) {
        const match = line.match(/name=([^\s]+)/);
        if (match) {
          const iface = match[1];
          try {
            const mon = await mt.exec(`/interface/wifi monitor [find name=${iface}] once`);
            console.log(`\n${iface}:`);
            console.log(mon);
          } catch(e) {
            console.log(`\n${iface}: Error - ${e.message}`);
          }
        }
      }
    } else {
      console.log('No virtual interfaces found');
    }

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
    console.log('Usage: node check-running.js <host> <username> <password>');
    console.log('Example: node check-running.js 192.168.88.1 admin admin');
    process.exit(1);
  }

  checkRunning(host, username, password);
}

module.exports = { checkRunning };
