#!/usr/bin/env node

const fs = require('fs');
const yaml = require('js-yaml');
const { configureMikroTik, configureCapInterfacesOnController, configureLocalCapFallback, ensureCapWifiInBridge, configureAccessLists, extractHostname } = require('./mikrotik-no-vlan-filtering.js');

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

function validateDeviceConfig(config, index, deploymentSsids) {
  const errors = [];
  const role = config.role || 'standalone';

  if (!config.device) {
    errors.push(`Device ${index}: Missing device configuration`);
  } else {
    if (!config.device.host) errors.push(`Device ${index}: Missing device.host`);
    if (!config.device.username) errors.push(`Device ${index}: Missing device.username`);
    if (!config.device.password) errors.push(`Device ${index}: Missing device.password`);
  }

  // CAP devices get SSIDs from controller, so they don't need local SSIDs
  if (role === 'cap') {
    // Validate CAP-specific config - support both capsman.* (new) and cap.* (legacy)
    const capsmanConfig = config.capsman || {};
    const legacyCapConfig = config.cap || {};
    const controllerAddresses = capsmanConfig.controllerAddresses || legacyCapConfig.controllerAddresses || [];
    if (controllerAddresses.length === 0) {
      errors.push(`Device ${index} (CAP): Missing capsman.controllerAddresses`);
    }
  } else {
    // Controller and standalone devices need SSIDs
    const ssids = config.ssids || deploymentSsids || [];
    if (ssids.length === 0) {
      errors.push(`Device ${index}: No SSIDs defined`);
    }

    ssids.forEach((ssid, ssidIndex) => {
      if (!ssid.ssid) errors.push(`Device ${index}, SSID ${ssidIndex}: missing ssid`);
      if (!ssid.passphrase) errors.push(`Device ${index}, SSID ${ssidIndex}: missing passphrase`);
      if (ssid.passphrase === 'UNKNOWN') {
        errors.push(`Device ${index}, SSID ${ssidIndex} (${ssid.ssid}): passphrase is UNKNOWN - please set a real passphrase. UNKNOWN is used in backups when passphrases cannot be retrieved from devices.`);
      }
      if (ssid.vlan === undefined) errors.push(`Device ${index}, SSID ${ssidIndex}: missing vlan`);
      if (!ssid.bands || ssid.bands.length === 0) {
        errors.push(`Device ${index}, SSID ${ssidIndex}: missing bands`);
      }
      if (ssid.bands) {
        ssid.bands.forEach(band => {
          if (band !== '2.4GHz' && band !== '5GHz') {
            errors.push(`Device ${index}, SSID ${ssidIndex}: invalid band '${band}'`);
          }
        });
      }
    });
  }

  return errors;
}

// Check if deployment uses CAPsMAN (has devices with role: controller or cap)
function isCapsmanDeployment(devices) {
  return devices.some(d => d.role === 'controller' || d.role === 'cap');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node apply-multiple-devices.js <config-file.yaml> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --parallel       Apply configurations in parallel (faster but causes network-wide outage)');
    console.log('  --sequential     Apply configurations sequentially (default, clearer output)');
    console.log('  --delay <secs>   Wait between devices for client roaming (default: 5, sequential only)');
    console.log('  --no-delay       Skip delay between devices');
    console.log('');
    console.log('Examples:');
    console.log('  node apply-multiple-devices.js multiple-devices.yaml');
    console.log('  node apply-multiple-devices.js multiple-devices.yaml --delay 10');
    console.log('  node apply-multiple-devices.js multiple-devices.yaml --no-delay');
    console.log('  node apply-multiple-devices.js multiple-devices.yaml --parallel');
    console.log('');
    console.log('The config file should contain a "devices" array with device configurations.');
    console.log('Use backup-multiple-devices.js to generate this file from existing devices.');
    console.log('');
    console.log('Note: WiFi clients experience brief disconnection during reconfiguration.');
    console.log('      The --delay option (default 5s) allows clients to roam between APs.');
    process.exit(1);
  }

  const configFile = args[0];
  const parallel = args.includes('--parallel');
  const noDelay = args.includes('--no-delay');

  // Parse --delay <seconds> option
  let staggerDelay = 5; // Default 5 seconds
  const delayIndex = args.indexOf('--delay');
  if (delayIndex !== -1 && args[delayIndex + 1]) {
    const parsedDelay = parseInt(args[delayIndex + 1], 10);
    if (!isNaN(parsedDelay) && parsedDelay >= 0) {
      staggerDelay = parsedDelay;
    }
  }
  if (noDelay) {
    staggerDelay = 0;
  }

  console.log('=== MikroTik Multi-Device Configuration ===');
  console.log(`Config file: ${configFile}`);
  console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}`);
  if (!parallel && staggerDelay > 0) {
    console.log(`Stagger delay: ${staggerDelay}s between devices (for client roaming)`);
  }
  console.log('');

  console.log(`Loading configuration from: ${configFile}`);
  const config = loadConfig(configFile);

  if (!config.devices || !Array.isArray(config.devices)) {
    console.error('✗ Config file must contain a "devices" array');
    process.exit(1);
  }

  const devices = config.devices;
  const deploymentCountry = config.country;  // Top-level country for all devices
  const deploymentSyslog = config.syslog;    // Top-level syslog for all devices
  console.log(`Found ${devices.length} device(s) to configure`);
  if (deploymentCountry) {
    console.log(`Country: ${deploymentCountry} (applies to all devices)`);
  }
  if (deploymentSyslog && deploymentSyslog.server) {
    console.log(`Syslog: ${deploymentSyslog.server}:${deploymentSyslog.port || 514} (applies to all devices)`);
    if (deploymentSyslog.topics) {
      console.log(`  Topics: ${deploymentSyslog.topics.join(', ')}`);
    }
  }
  console.log('');

  // Check for CAPsMAN deployment
  const capsmanMode = isCapsmanDeployment(devices);
  const deploymentSsids = config.ssids || [];  // Deployment-level SSIDs for CAPsMAN
  const capsmanVlan = config.capsmanVlan || null;  // Deployment-level CAPsMAN VLAN config

  if (capsmanVlan) {
    console.log(`CAPsMAN VLAN: ${capsmanVlan.vlan} (Network: ${capsmanVlan.network || 'unspecified'})`);
  }

  if (capsmanMode) {
    const controller = devices.find(d => d.role === 'controller');
    const caps = devices.filter(d => d.role === 'cap');
    console.log('CAPsMAN deployment detected:');
    console.log(`  Controller: ${controller ? controller.device?.host : 'MISSING'}`);
    console.log(`  CAP devices: ${caps.length}`);
    if (deploymentSsids.length > 0) {
      console.log(`  Shared SSIDs: ${deploymentSsids.length}`);
    }
    console.log('');

    if (!controller) {
      console.error('✗ CAPsMAN deployment requires a device with role: controller');
      process.exit(1);
    }
  }

  // Validate all devices first
  console.log('Validating configurations...');
  let hasValidationErrors = false;

  for (let i = 0; i < devices.length; i++) {
    const errors = validateDeviceConfig(devices[i], i + 1, deploymentSsids);
    if (errors.length > 0) {
      console.error(`\nValidation errors for device ${i + 1}:`);
      errors.forEach(err => console.error(`  - ${err}`));
      hasValidationErrors = true;
    }
  }

  if (hasValidationErrors) {
    console.error('\n✗ Configuration validation failed');
    process.exit(1);
  }

  console.log('✓ All configurations valid\n');

  // Helper to build mtConfig from deviceConfig
  function buildMtConfig(deviceConfig) {
    // Merge deployment-level country into device wifi config
    let wifi = deviceConfig.wifi;
    if (deploymentCountry && wifi && !wifi.country) {
      wifi = { ...wifi, country: deploymentCountry };
    } else if (deploymentCountry && !wifi) {
      wifi = { country: deploymentCountry };
    }

    const role = deviceConfig.role || 'standalone';

    // For controller: use deployment-level SSIDs if no device-level SSIDs
    // For CAP: no SSIDs needed (gets from controller)
    let ssids = deviceConfig.ssids;
    if (role === 'controller' && (!ssids || ssids.length === 0)) {
      ssids = deploymentSsids;
    }

    // Build unified capsman config from various sources
    // New unified format: capsman.vlan.id/network/address
    // Legacy formats: cap.capsmanVlan.vlan, capsmanVlan.vlan, capsmanAddress
    const deviceCapsmanConfig = deviceConfig.capsman || {};
    const legacyCap = deviceConfig.cap || {};

    // Build vlan config: prefer new capsman.vlan format, fall back to legacy
    let vlanConfig = null;
    if (capsmanVlan || deviceCapsmanConfig.vlan || legacyCap.capsmanVlan) {
      vlanConfig = {
        // VLAN ID: new format uses 'id', legacy uses 'vlan'
        id: deviceCapsmanConfig.vlan?.id ||
            legacyCap.capsmanVlan?.vlan ||
            capsmanVlan?.vlan,
        // Network comes from deployment or device
        network: deviceCapsmanConfig.vlan?.network ||
                 legacyCap.capsmanVlan?.network ||
                 capsmanVlan?.network,
        // Address is always device-specific
        address: deviceCapsmanConfig.vlan?.address ||
                 legacyCap.capsmanVlan?.address ||
                 deviceConfig.capsmanAddress
      };
    }

    return {
      host: deviceConfig.device.host,
      username: deviceConfig.device.username,
      password: deviceConfig.device.password,
      identity: deviceConfig.identity,
      managementInterfaces: deviceConfig.managementInterfaces || ['ether1'],
      disabledInterfaces: deviceConfig.disabledInterfaces || [],
      igmpSnooping: deviceConfig.igmpSnooping,
      wifi,
      syslog: deploymentSyslog,
      ssids,
      role,
      // Unified capsman config
      capsman: {
        ...deviceCapsmanConfig,
        ...legacyCap,  // Include legacy cap fields (controllerAddresses, etc.)
        vlan: vlanConfig
      }
    };
  }

  // Apply configurations
  const results = [];

  // CAPsMAN deployment: controller first, then CAPs
  if (capsmanMode) {
    const controller = devices.find(d => d.role === 'controller');
    const caps = devices.filter(d => d.role === 'cap');
    const standalones = devices.filter(d => !d.role || d.role === 'standalone');

    // Phase 1: Configure controller
    console.log('=== Phase 1: Configuring CAPsMAN Controller ===\n');
    const controllerConfig = buildMtConfig(controller);
    const controllerIndex = devices.indexOf(controller) + 1;

    console.log(`${'='.repeat(60)}`);
    console.log(`[Controller] ${controllerConfig.host}`);
    console.log(`${'='.repeat(60)}`);
    if (controllerConfig.ssids && controllerConfig.ssids.length > 0) {
      console.log(`Master configurations (SSIDs): ${controllerConfig.ssids.length}`);
      controllerConfig.ssids.forEach(ssid => {
        const roamingInfo = [];
        if (ssid.roaming?.fastTransition) roamingInfo.push('802.11r');
        if (ssid.roaming?.rrm) roamingInfo.push('802.11k');
        if (ssid.roaming?.wnm) roamingInfo.push('802.11v');
        const roamingStr = roamingInfo.length > 0 ? ` [${roamingInfo.join(',')}]` : '';
        console.log(`  - ${ssid.ssid} (VLAN ${ssid.vlan}, Bands: ${ssid.bands.join(', ')})${roamingStr}`);
      });
    }
    console.log('');

    try {
      await configureMikroTik(controllerConfig);
      results.push({ index: controllerIndex, host: controllerConfig.host, role: 'controller', success: true });
      console.log(`\n✓ Controller configured: ${controllerConfig.host}`);
    } catch (error) {
      results.push({ index: controllerIndex, host: controllerConfig.host, role: 'controller', success: false, error: error.message });
      console.error(`\n✗ Controller configuration failed: ${error.message}`);
      console.error('Cannot proceed with CAP configuration without controller.');
      process.exit(1);
    }

    // Wait for CAPsMAN to initialize
    console.log('\n⏳ Waiting 5s for CAPsMAN service to initialize...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Phase 2: Configure CAPs
    if (caps.length > 0) {
      console.log(`\n=== Phase 2: Configuring ${caps.length} CAP Device(s) ===\n`);

      if (parallel) {
        const capPromises = caps.map(async (deviceConfig) => {
          const mtConfig = buildMtConfig(deviceConfig);
          const capIndex = devices.indexOf(deviceConfig) + 1;
          try {
            await configureMikroTik(mtConfig);
            return { index: capIndex, host: mtConfig.host, role: 'cap', success: true };
          } catch (error) {
            return { index: capIndex, host: mtConfig.host, role: 'cap', success: false, error: error.message };
          }
        });
        const capResults = await Promise.all(capPromises);
        results.push(...capResults);
      } else {
        for (let i = 0; i < caps.length; i++) {
          const deviceConfig = caps[i];
          const mtConfig = buildMtConfig(deviceConfig);
          const capIndex = devices.indexOf(deviceConfig) + 1;

          console.log(`${'='.repeat(60)}`);
          console.log(`[CAP ${i + 1}/${caps.length}] ${mtConfig.host}`);
          console.log(`${'='.repeat(60)}`);
          console.log(`Controller: ${mtConfig.capsman?.controllerAddresses?.join(', ') || 'not specified'}`);
          console.log('');

          try {
            await configureMikroTik(mtConfig);
            results.push({ index: capIndex, host: mtConfig.host, role: 'cap', success: true });
            console.log(`\n✓ CAP configured: ${mtConfig.host}`);
          } catch (error) {
            results.push({ index: capIndex, host: mtConfig.host, role: 'cap', success: false, error: error.message });
            console.error(`\n✗ CAP configuration failed: ${error.message}`);
          }

          // Stagger delay between CAPs
          const isLastCap = i === caps.length - 1;
          if (!isLastCap && staggerDelay > 0) {
            console.log(`\n⏳ Waiting ${staggerDelay}s before next CAP...`);
            await new Promise(resolve => setTimeout(resolve, staggerDelay * 1000));
          }
        }
      }

      // Phase 2.5: Configure CAP interfaces on controller (wifi-qcom only)
      // For wifi-qcom CAPsMAN, CAP interfaces must be configured directly after CAPs connect
      // This function detects the WiFi package and skips if wifiwave2 (uses provisioning rules)
      console.log('\n=== Phase 2.5: Configuring CAP Interfaces on Controller ===\n');
      console.log('⏳ Waiting 3s for CAP interfaces to appear...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Build array of CAP device configs with wifi settings (txPower, etc.)
      // These are passed to configure per-device settings on CAP interfaces
      const capDeviceConfigs = caps.map(cap => ({
        host: cap.device?.host,
        identity: cap.identity,
        wifi: cap.wifi
      }));

      try {
        await configureCapInterfacesOnController(controllerConfig, capDeviceConfigs);
        console.log('✓ CAP interface configuration complete');
      } catch (error) {
        console.error(`⚠️  CAP interface configuration warning: ${error.message}`);
        console.error('    CAP interfaces may need manual configuration.');
      }
    }

    // Phase 2.75: Configure access-lists (WAP locking)
    // Collect lockedDevices from all device configs
    const allLockedDevices = devices.flatMap(device =>
      (device.lockedDevices || []).map(ld => ({
        ...ld,
        lockToAp: device.identity || extractHostname(device.device?.host)
      }))
    );

    if (allLockedDevices.length > 0) {
      console.log(`\n=== Phase 2.75: Configuring Access-Lists (${allLockedDevices.length} locked device(s)) ===\n`);
      try {
        await configureAccessLists(controllerConfig, allLockedDevices, deploymentSsids, devices);
        console.log('✓ Access-list configuration complete');
      } catch (error) {
        console.error(`⚠️  Access-list configuration warning: ${error.message}`);
        console.error('    Locked devices may not be properly configured.');
      }
    }

    // Phase 2.6: Configure local WiFi fallback on CAP devices
    // This allows CAPs to continue providing WiFi even when controller is unreachable
    if (caps.length > 0 && deploymentSsids.length > 0) {
      console.log(`\n=== Phase 2.6: Configuring Local WiFi Fallback on CAP Devices ===\n`);

      for (const cap of caps) {
        const capConfig = {
          host: cap.device.host,
          username: cap.device.username,
          password: cap.device.password,
          identity: cap.identity,
          wifi: cap.wifi
        };

        try {
          await configureLocalCapFallback(capConfig, deploymentSsids, deploymentCountry || 'United States');
        } catch (error) {
          // Non-fatal - CAP still works with controller, just no fallback
          console.error(`⚠️  Local fallback warning for ${cap.device.host}: ${error.message}`);
        }
      }

      console.log('\n✓ Local WiFi fallback configuration complete');
    }

    // Phase 2.7: Ensure WiFi interfaces are in bridge for IGMP snooping
    // Virtual WiFi interfaces on CAPs may not be automatically added as bridge ports,
    // which breaks IGMP snooping (multicast groups not tracked on those interfaces)
    if (caps.length > 0) {
      console.log(`\n=== Phase 2.7: Ensuring WiFi Bridge Ports for IGMP Snooping ===\n`);

      for (const cap of caps) {
        const capConfig = {
          host: cap.device.host,
          username: cap.device.username,
          password: cap.device.password,
          identity: cap.identity
        };

        try {
          await ensureCapWifiInBridge(capConfig);
        } catch (error) {
          // Non-fatal - IGMP might not work but basic WiFi will
          console.error(`⚠️  Bridge port check warning for ${cap.device.host}: ${error.message}`);
        }
      }

      console.log('\n✓ WiFi bridge port verification complete');
    }

    // Phase 3: Configure standalone devices (if any mixed in)
    if (standalones.length > 0) {
      console.log(`\n=== Phase 3: Configuring ${standalones.length} Standalone Device(s) ===\n`);
      for (const deviceConfig of standalones) {
        const mtConfig = buildMtConfig(deviceConfig);
        const devIndex = devices.indexOf(deviceConfig) + 1;
        try {
          await configureMikroTik(mtConfig);
          results.push({ index: devIndex, host: mtConfig.host, role: 'standalone', success: true });
        } catch (error) {
          results.push({ index: devIndex, host: mtConfig.host, role: 'standalone', success: false, error: error.message });
        }
      }
    }

  } else if (parallel) {
    // Standard parallel deployment (non-CAPsMAN)
    console.log('Applying configurations in parallel...\n');

    const promises = devices.map(async (deviceConfig, index) => {
      const mtConfig = buildMtConfig(deviceConfig);
      try {
        await configureMikroTik(mtConfig);
        return { index: index + 1, host: mtConfig.host, success: true };
      } catch (error) {
        return { index: index + 1, host: mtConfig.host, success: false, error: error.message };
      }
    });

    const allResults = await Promise.all(promises);
    results.push(...allResults);

  } else {
    // Standard sequential deployment (non-CAPsMAN)
    console.log('Applying configurations sequentially...\n');

    for (let i = 0; i < devices.length; i++) {
      const deviceConfig = devices[i];
      const mtConfig = buildMtConfig(deviceConfig);

      console.log(`\n${'='.repeat(60)}`);
      console.log(`[${i + 1}/${devices.length}] Configuring device: ${mtConfig.host}`);
      console.log(`${'='.repeat(60)}`);
      if (mtConfig.ssids && mtConfig.ssids.length > 0) {
        console.log(`SSIDs to configure: ${mtConfig.ssids.length}`);
        mtConfig.ssids.forEach(ssid => {
          console.log(`  - ${ssid.ssid} (VLAN ${ssid.vlan}, Bands: ${ssid.bands.join(', ')})`);
        });
      }
      console.log('');

      try {
        await configureMikroTik(mtConfig);
        results.push({ index: i + 1, host: mtConfig.host, success: true });
        console.log(`\n✓ Successfully configured ${mtConfig.host}`);
      } catch (error) {
        results.push({ index: i + 1, host: mtConfig.host, success: false, error: error.message });
        console.error(`\n✗ Failed to configure ${mtConfig.host}: ${error.message}`);
      }

      // Stagger delay between devices to allow WiFi clients to roam
      const isLastDevice = i === devices.length - 1;
      if (!isLastDevice && staggerDelay > 0) {
        console.log(`\n⏳ Waiting ${staggerDelay}s for WiFi clients to roam before next device...`);
        await new Promise(resolve => setTimeout(resolve, staggerDelay * 1000));
      }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Configuration Summary');
  console.log(`${'='.repeat(60)}\n`);

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`Total devices: ${devices.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);

  if (successful.length > 0) {
    console.log('\n✓ Successfully configured:');
    successful.forEach(r => {
      const roleStr = r.role ? ` (${r.role})` : '';
      console.log(`  - Device ${r.index}: ${r.host}${roleStr}`);
    });
  }

  if (failed.length > 0) {
    console.log('\n✗ Failed to configure:');
    failed.forEach(r => {
      const roleStr = r.role ? ` (${r.role})` : '';
      console.log(`  - Device ${r.index}: ${r.host}${roleStr} - ${r.error}`);
    });
    process.exit(1);
  }

  if (capsmanMode) {
    console.log('\n✓ CAPsMAN deployment configured successfully!');
    console.log('  CAPs should now be connected to the controller.');
  } else {
    console.log('\n✓ All devices configured successfully!');
  }
}

main();
