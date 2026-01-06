#!/usr/bin/env node

/**
 * Validate VLAN Configuration for MikroTik WiFi Access Points
 *
 * This script connects to a MikroTik device and validates:
 * 1. WiFi interfaces are correctly mapped to datapaths
 * 2. Datapaths have correct VLAN IDs
 * 3. Bridge configuration supports VLAN tagging
 */

const { MikroTikSSH } = require('../mikrotik-no-vlan-filtering.js');

async function validateVLANConfig(host, username, password) {
  const mt = new MikroTikSSH(host, username, password);

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('VLAN Configuration Validation');
    console.log(`Device: ${host}`);
    console.log('========================================\n');

    // Step 1: Get WiFi interfaces
    console.log('=== WiFi Interfaces ===');
    const wifiOutput = await mt.exec('/interface wifi print detail without-paging');

    // Parse WiFi interfaces
    const interfaces = [];
    const lines = wifiOutput.split('\n');
    let currentInterface = null;

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

    // Extract interface details
    const wifiInterfaces = [];
    for (const iface of interfaces) {
      const raw = iface.raw;
      const nameMatch = raw.match(/name="?([^"\s]+)"?/);
      const ssidMatch = raw.match(/(?:configuration)?\.ssid="([^"]+)"/);
      const datapathMatch = raw.match(/datapath="?([^"\s]+)"?/);
      const disabledMatch = raw.match(/disabled=yes/);

      if (!nameMatch || disabledMatch) continue;

      const name = nameMatch[1];
      const ssid = ssidMatch ? ssidMatch[1] : null;
      const datapath = datapathMatch ? datapathMatch[1] : null;

      if (name && (ssid || datapath)) {
        wifiInterfaces.push({ name, ssid, datapath });
        console.log(`Interface: ${name}`);
        if (ssid) console.log(`  SSID: ${ssid}`);
        if (datapath) console.log(`  Datapath: ${datapath}`);
      }
    }

    // Step 2: Get datapath VLAN mappings
    console.log('\n=== WiFi Datapaths ===');
    const datapathOutput = await mt.exec('/interface wifi datapath print detail without-paging');
    const dpLines = datapathOutput.split('\n');

    const datapaths = {};
    for (const line of dpLines) {
      const nameMatch = line.match(/name="?([^"\s]+)"?/);
      const vlanMatch = line.match(/vlan-id=(\d+)/);
      const bridgeMatch = line.match(/bridge=([^\s]+)/);

      if (nameMatch) {
        const dpName = nameMatch[1];
        datapaths[dpName] = {
          vlan: vlanMatch ? parseInt(vlanMatch[1]) : null,
          bridge: bridgeMatch ? bridgeMatch[1] : null
        };

        console.log(`Datapath: ${dpName}`);
        if (datapaths[dpName].vlan) console.log(`  VLAN ID: ${datapaths[dpName].vlan}`);
        if (datapaths[dpName].bridge) console.log(`  Bridge: ${datapaths[dpName].bridge}`);
      }
    }

    // Step 3: Map SSIDs to VLANs
    console.log('\n=== SSID → VLAN Mapping ===');
    const ssidToVlan = {};

    for (const iface of wifiInterfaces) {
      if (iface.ssid && iface.datapath && datapaths[iface.datapath]) {
        const vlan = datapaths[iface.datapath].vlan;
        if (vlan) {
          if (!ssidToVlan[iface.ssid]) {
            ssidToVlan[iface.ssid] = new Set();
          }
          ssidToVlan[iface.ssid].add(vlan);
        }
      }
    }

    for (const [ssid, vlans] of Object.entries(ssidToVlan)) {
      const vlanList = Array.from(vlans).sort((a, b) => a - b);
      console.log(`SSID: ${ssid} → VLAN ${vlanList.join(', ')}`);
    }

    // Step 4: Check bridge configuration
    console.log('\n=== Bridge Configuration ===');
    const bridgeOutput = await mt.exec('/interface bridge print detail without-paging');
    const vlanFilteringMatch = bridgeOutput.match(/vlan-filtering=(yes|no)/);

    if (vlanFilteringMatch) {
      console.log(`VLAN Filtering: ${vlanFilteringMatch[1]}`);
      if (vlanFilteringMatch[1] === 'yes') {
        console.log('⚠️  WARNING: VLAN filtering is ENABLED - this may cause lockout!');
      } else {
        console.log('✓ VLAN filtering is disabled (safe configuration)');
      }
    }

    // Step 5: Check bridge ports
    console.log('\n=== Bridge Ports ===');
    const bridgePortOutput = await mt.exec('/interface bridge port print detail without-paging');
    const bpLines = bridgePortOutput.split('\n');

    for (const line of bpLines) {
      const ifaceMatch = line.match(/interface=([^\s]+)/);
      const bridgeMatch = line.match(/bridge=([^\s]+)/);
      if (ifaceMatch && bridgeMatch) {
        console.log(`${ifaceMatch[1]} → ${bridgeMatch[1]}`);
      }
    }

    // Step 6: Validation summary
    console.log('\n=== Validation Summary ===');

    let hasIssues = false;

    // Check for SSIDs without datapaths
    for (const iface of wifiInterfaces) {
      if (iface.ssid && !iface.datapath) {
        console.log(`✗ ${iface.name} (${iface.ssid}) has no datapath - VLAN tagging disabled!`);
        hasIssues = true;
      }
    }

    // Check for datapaths without VLANs
    for (const [dpName, dp] of Object.entries(datapaths)) {
      if (!dp.vlan) {
        console.log(`✗ Datapath ${dpName} has no VLAN ID configured`);
        hasIssues = true;
      }
      if (!dp.bridge) {
        console.log(`✗ Datapath ${dpName} has no bridge configured`);
        hasIssues = true;
      }
    }

    // Check for SSID → VLAN uniqueness
    for (const [ssid, vlans] of Object.entries(ssidToVlan)) {
      if (vlans.size === 1) {
        console.log(`✓ ${ssid} is correctly isolated on VLAN ${Array.from(vlans)[0]}`);
      } else {
        console.log(`⚠️  ${ssid} is mapped to multiple VLANs: ${Array.from(vlans).join(', ')}`);
      }
    }

    // Check for different SSIDs on different VLANs (isolation verification)
    const ssidList = Object.keys(ssidToVlan);
    for (let i = 0; i < ssidList.length; i++) {
      for (let j = i + 1; j < ssidList.length; j++) {
        const ssid1 = ssidList[i];
        const ssid2 = ssidList[j];
        const vlan1 = Array.from(ssidToVlan[ssid1]);
        const vlan2 = Array.from(ssidToVlan[ssid2]);

        const hasOverlap = vlan1.some(v => vlan2.includes(v));
        if (hasOverlap) {
          console.log(`⚠️  ${ssid1} and ${ssid2} share VLAN(s) - not isolated!`);
        } else {
          console.log(`✓ ${ssid1} (VLAN ${vlan1}) and ${ssid2} (VLAN ${vlan2}) are isolated`);
        }
      }
    }

    if (!hasIssues) {
      console.log('\n✓✓✓ All VLAN configurations are valid ✓✓✓');
    } else {
      console.log('\n⚠️⚠️⚠️ Issues detected in VLAN configuration ⚠️⚠️⚠️');
    }

    console.log('\n========================================\n');

    await mt.close();
    return !hasIssues;
  } catch (error) {
    console.error('\n✗ Validation Error:', error.message);
    await mt.close();
    throw error;
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.log('Usage: validate-vlan-config.js <host> <username> <password>');
    console.log('Example: validate-vlan-config.js 192.168.88.1 admin password');
    process.exit(1);
  }

  const [host, username, password] = args;

  validateVLANConfig(host, username, password)
    .then(success => process.exit(success ? 0 : 1))
    .catch(err => {
      console.error('Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { validateVLANConfig };
