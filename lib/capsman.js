/**
 * CAPsMAN controller and CAP configuration
 * Functions for configuring CAPsMAN controllers and CAP devices
 */

const { MikroTikSSH } = require('./ssh-client');
const { CHANNEL_FREQ_24GHZ, CHANNEL_FREQ_5GHZ } = require('./constants');
const { escapeMikroTik, getWifiPath, getCapsmanPath, getCapPath } = require('./utils');
const {
  setDeviceIdentity,
  detectWifiPackage,
  ensureBridgeInfrastructure,
  configureManagementInterfaces,
  configureDisabledInterfaces,
  enableDhcpClient,
  configureSyslog,
  configureCapsmanVlan
} = require('./infrastructure');
const {
  detectRadioLayout,
  applyBandSettings,
  configureWifiInterface,
  discoverCapInterfaces
} = require('./wifi-config');

/**
 * Configure CAP-operated interfaces on a CAPsMAN controller (wifi-qcom specific)
 * This configures the interfaces directly after CAPs have connected.
 *
 * @param {Object} config - Controller configuration
 * @returns {boolean} - Success status
 */
async function configureCapInterfacesOnController(config = {}) {
  const mt = new MikroTikSSH(
    config.host || '192.168.88.1',
    config.username || 'admin',
    config.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('Configuring CAP Interfaces (wifi-qcom)');
    console.log('========================================\n');

    const ssids = config.ssids || [];
    const wifiConfig = config.wifi || {};
    const country = wifiConfig.country || 'United States';

    if (ssids.length === 0) {
      console.log('⚠️  No SSIDs configured');
      await mt.close();
      return false;
    }

    // Detect WiFi package
    const wifiPackage = await detectWifiPackage(mt);
    if (!wifiPackage) {
      console.log('✗ Could not detect WiFi package');
      await mt.close();
      return false;
    }

    // wifiwave2 uses provisioning rules - CAP interfaces are auto-configured
    if (wifiPackage === 'wifiwave2') {
      console.log('ℹ️  wifiwave2 detected - provisioning rules handle CAP interface configuration');
      console.log('✓ Skipping Phase 2.5 (not needed for wifiwave2)');
      await mt.close();
      return true;
    }

    const wifiPath = getWifiPath(wifiPackage);

    // Discover CAP interfaces
    console.log('=== Discovering CAP Interfaces ===');
    const capInterfaces = await discoverCapInterfaces(mt, wifiPath, wifiPackage);

    if (capInterfaces.length === 0) {
      console.log('⚠️  No CAP interfaces found. CAPs may not have connected yet.');
      console.log('    Wait for CAPs to connect and run this again.');
      await mt.close();
      return false;
    }

    console.log(`Found ${capInterfaces.length} CAP interface(s):`);
    for (const iface of capInterfaces) {
      console.log(`  - ${iface.name} (${iface.band})`);
    }

    // Clean up existing virtual interfaces for CAP master interfaces
    // This ensures idempotency - we start fresh each time
    console.log('\n=== Cleaning Up Old CAP Virtual Interfaces ===');
    for (const capInterface of capInterfaces) {
      try {
        // Check for existing virtual interfaces
        const virtualCheck = await mt.exec(
          `${wifiPath} print terse where master-interface="${capInterface.name}"`
        );

        if (virtualCheck && virtualCheck.trim()) {
          // Count how many virtuals exist
          const lines = virtualCheck.split('\n').filter(l => l.trim());
          if (lines.length > 0) {
            await mt.exec(
              `${wifiPath} remove [find master-interface="${capInterface.name}"]`
            );
            console.log(`  ✓ Removed ${lines.length} virtual interface(s) from ${capInterface.name}`);
          }
        }
      } catch (e) {
        if (!e.message.includes('no such item') && !e.message.includes('not found')) {
          console.log(`  ⚠️  Could not clean ${capInterface.name}: ${e.message}`);
        }
      }
    }

    // Group SSIDs by band
    const ssidsByBand = {
      '2.4GHz': ssids.filter(s => s.bands && s.bands.includes('2.4GHz')),
      '5GHz': ssids.filter(s => s.bands && s.bands.includes('5GHz'))
    };

    // Configure each CAP interface
    console.log('\n=== Configuring CAP Interfaces ===');

    for (const capInterface of capInterfaces) {
      const bandSsids = ssidsByBand[capInterface.band];

      if (!bandSsids || bandSsids.length === 0) {
        console.log(`⚠️  No SSIDs configured for ${capInterface.band} (${capInterface.name})`);
        continue;
      }

      // Configure primary SSID on master interface
      const primarySsid = bandSsids[0];
      console.log(`\nConfiguring ${capInterface.name} with SSID: ${primarySsid.ssid}`);

      await configureWifiInterface(
        mt, wifiPath, capInterface.name, primarySsid, country
      );

      // Create virtual interfaces for additional SSIDs
      for (let i = 1; i < bandSsids.length; i++) {
        const additionalSsid = bandSsids[i];
        const virtualName = `${capInterface.name}-ssid${i + 1}`;

        console.log(`\nCreating virtual interface ${virtualName} for SSID: ${additionalSsid.ssid}`);

        // Create virtual interface
        try {
          await mt.exec(`${wifiPath} add master-interface=${capInterface.name} name="${virtualName}"`);
          console.log(`  ✓ Created virtual interface ${virtualName}`);
        } catch (e) {
          if (e.message.includes('already have') || e.message.includes('exists')) {
            console.log(`  ✓ Virtual interface ${virtualName} already exists`);
          } else {
            console.log(`  ⚠️  Could not create ${virtualName}: ${e.message}`);
            continue;
          }
        }

        // Small delay for interface registration
        await new Promise(resolve => setTimeout(resolve, 300));

        await configureWifiInterface(
          mt, wifiPath, virtualName, additionalSsid, country
        );
      }
    }

    console.log('\n========================================');
    console.log('✓ CAP Interface Configuration Complete');
    console.log('========================================\n');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ CAP Interface Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

/**
 * Configure device as CAPsMAN Controller
 * Creates master configurations, provisioning rules, and enables CAPsMAN service
 */
async function configureController(config = {}) {
  const mt = new MikroTikSSH(
    config.host || '192.168.88.1',
    config.username || 'admin',
    config.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('MikroTik CAPsMAN Controller Configuration');
    console.log('========================================\n');

    const ssids = config.ssids || [];
    const capsmanConfig = config.capsman || {};

    if (ssids.length === 0) {
      console.log('⚠️  No SSIDs configured');
      await mt.close();
      return false;
    }

    // Step 0: Set device identity
    await setDeviceIdentity(mt, config);

    // Step 1: Detect WiFi package
    const wifiPackage = await detectWifiPackage(mt);
    if (!wifiPackage) {
      await mt.close();
      return false;
    }

    const capsmanPath = getCapsmanPath(wifiPackage);
    const wifiPath = getWifiPath(wifiPackage);

    // Step 2: Ensure bridge and disable VLAN filtering
    await ensureBridgeInfrastructure(mt);

    // Step 3: Configure management interfaces
    await configureManagementInterfaces(mt, config);
    await configureDisabledInterfaces(mt, config);

    // Step 4: Enable DHCP client
    await enableDhcpClient(mt);

    // Step 4.5: Configure CAPsMAN VLAN (if specified)
    await configureCapsmanVlan(mt, config);

    const wifiConfig = config.wifi || {};
    const country = wifiConfig.country || 'United States';

    // Steps 5-6 are only for wifiwave2 devices
    // wifi-qcom doesn't support configuration/provisioning objects
    // Instead, CAP interfaces are configured directly after CAPs connect (Phase 2.5)

    if (wifiPackage === 'wifiwave2') {
      // Step 5: Clean up old CAPsMAN configurations
      console.log('\n=== Cleaning Up Old CAPsMAN Configurations ===');
      try {
        await mt.exec(`${capsmanPath}/provisioning remove [find]`);
        console.log('✓ Removed old provisioning rules');
      } catch (e) {
        if (!e.message.includes('no such item')) {
          console.log(`⚠️  Provisioning cleanup: ${e.message}`);
        }
      }

      try {
        await mt.exec(`${capsmanPath}/configuration remove [find]`);
        console.log('✓ Removed old master configurations');
      } catch (e) {
        if (!e.message.includes('no such item')) {
          console.log(`⚠️  Configuration cleanup: ${e.message}`);
        }
      }

      // Step 6: Create master configurations for each SSID
      console.log('\n=== Creating Master Configurations ===');

      for (const ssidConfig of ssids) {
        const { ssid, passphrase, vlan, bands, roaming } = ssidConfig;

        if (!ssid || !passphrase || !vlan || !bands || bands.length === 0) {
          console.log(`⚠️  Skipping incomplete SSID: ${ssid || 'unnamed'}`);
          continue;
        }

        console.log(`\nConfiguring SSID: ${ssid}`);

        const useFT = roaming?.fastTransition === true;
        const useRRM = roaming?.rrm === true;
        const useWNM = roaming?.wnm === true;
        const transitionThreshold = roaming?.transitionThreshold || -80;

        const authTypes = useFT ? 'wpa2-psk,ft-psk' : 'wpa2-psk';
        const escapedSsid = escapeMikroTik(ssid);
        const escapedPassphrase = escapeMikroTik(passphrase);

        for (const band of bands) {
          const bandSuffix = band === '2.4GHz' ? '2g' : '5g';
          const configName = `cfg-${ssid.replace(/[^a-zA-Z0-9]/g, '')}-${bandSuffix}`;
          const bandSpec = band === '2.4GHz' ? '2ghz-ax,2ghz-n' : '5ghz-ax,5ghz-n,5ghz-ac';

          const bandConfig = wifiConfig[band] || {};
          const channelCmd = bandConfig.channel ?
            `channel.frequency=${band === '2.4GHz' ? CHANNEL_FREQ_24GHZ[bandConfig.channel] : CHANNEL_FREQ_5GHZ[bandConfig.channel]}` : '';
          const txPowerCmd = bandConfig.txPower ? `channel.tx-power=${bandConfig.txPower}` : '';
          const widthCmd = bandConfig.width ? `channel.width=${bandConfig.width}` : '';

          let configCmd = `${capsmanPath}/configuration add ` +
            `name="${configName}" ssid="${escapedSsid}" country="${country}" ` +
            `security.authentication-types=${authTypes} security.passphrase="${escapedPassphrase}" ` +
            `datapath.bridge=bridge datapath.vlan-id=${vlan}`;

          if (useFT) configCmd += ` security.ft=yes security.ft-over-ds=yes`;
          if (useRRM) configCmd += ` steering.rrm=yes`;
          if (useWNM) configCmd += ` steering.wnm=yes steering.transition-threshold=${transitionThreshold}`;
          if (channelCmd) configCmd += ` ${channelCmd}`;
          if (txPowerCmd) configCmd += ` ${txPowerCmd}`;
          if (widthCmd) configCmd += ` ${widthCmd}`;

          try {
            await mt.exec(configCmd);
            console.log(`  ✓ Created master config: ${configName} (${band})`);
            if (useFT) console.log(`    802.11r: enabled`);
            if (useRRM) console.log(`    802.11k: enabled`);
            if (useWNM) console.log(`    802.11v: enabled (threshold: ${transitionThreshold} dBm)`);
          } catch (e) {
            console.log(`  ✗ Failed to create config ${configName}: ${e.message}`);
          }

          try {
            await mt.exec(
              `${capsmanPath}/provisioning add supported-bands=${bandSpec} ` +
              `master-configuration="${configName}" action=create-dynamic-enabled`
            );
            console.log(`  ✓ Created provisioning rule for ${bandSpec}`);
          } catch (e) {
            console.log(`  ⚠️  Provisioning rule: ${e.message}`);
          }
        }
      }
    } else {
      // wifi-qcom: Skip configuration/provisioning objects
      console.log('\n=== wifi-qcom CAPsMAN Mode ===');
      console.log('ℹ️  wifi-qcom does not use configuration/provisioning objects.');
      console.log('ℹ️  CAP interfaces will be configured after CAPs connect (Phase 2.5).');
      console.log(`ℹ️  SSIDs to configure: ${ssids.map(s => s.ssid).join(', ')}`);
    }

    // Step 7: Enable CAPsMAN service
    console.log('\n=== Enabling CAPsMAN Service ===');
    const certificate = capsmanConfig.certificate || 'auto';
    const requirePeerCert = capsmanConfig.requirePeerCertificate ? 'yes' : 'no';

    try {
      await mt.exec(`${capsmanPath} set enabled=yes ca-certificate=${certificate} require-peer-certificate=${requirePeerCert}`);
      console.log(`✓ CAPsMAN enabled with certificate: ${certificate}`);
      if (capsmanConfig.requirePeerCertificate) {
        console.log('✓ Mutual certificate authentication enabled');
      }
    } catch (e) {
      console.log(`✗ Failed to enable CAPsMAN: ${e.message}`);
    }

    // Step 8: Configure local WiFi interfaces (controller also acts as AP)
    console.log('\n=== Configuring Local WiFi (Controller as AP) ===');
    try {
      await mt.exec(`${wifiPath} set wifi1 configuration.manager=capsman-or-local`);
      await mt.exec(`${wifiPath} set wifi2 configuration.manager=capsman-or-local`);
      console.log('✓ Local WiFi interfaces set to CAPsMAN-managed');
    } catch (e) {
      console.log(`⚠️  Local WiFi config: ${e.message}`);
    }

    // Step 9: Configure Syslog
    await configureSyslog(mt, config);

    // Step 10: Validate CAPsMAN configuration was applied correctly
    console.log('\n=== Validating CAPsMAN Configuration ===');
    const validationErrors = [];

    // Check CAPsMAN is enabled
    try {
      const capsmanStatus = await mt.exec(`${capsmanPath} print`);
      if (!capsmanStatus.includes('enabled: yes') && !capsmanStatus.includes('enabled=yes')) {
        validationErrors.push('CAPsMAN is not enabled');
      } else {
        console.log('✓ CAPsMAN service is enabled');
      }
    } catch (e) {
      validationErrors.push(`Could not verify CAPsMAN status: ${e.message}`);
    }

    // Validation differs by package type
    if (wifiPackage === 'wifiwave2') {
      // wifiwave2: Check provisioning rules and configurations exist
      try {
        const provisioningOutput = await mt.exec(`${capsmanPath}/provisioning print`);
        const hasProvisioningRules = provisioningOutput.split('\n')
          .filter(line => line.trim() && !line.includes('Flags:') && !line.includes('Columns:') && !line.includes('#')).length > 0;

        if (!hasProvisioningRules) {
          validationErrors.push('No provisioning rules found - CAPs will not receive configuration');
        } else {
          console.log('✓ Provisioning rules configured');
        }
      } catch (e) {
        if (!e.message.includes('no such item')) {
          validationErrors.push(`Could not verify provisioning rules: ${e.message}`);
        }
      }

      // Check master configurations exist
      try {
        const configOutput = await mt.exec(`${capsmanPath}/configuration print`);
        const hasConfigurations = configOutput.split('\n')
          .filter(line => line.trim() && !line.includes('Flags:') && !line.includes('Columns:') && !line.includes('#')).length > 0;

        if (!hasConfigurations) {
          validationErrors.push('No master configurations found - SSIDs not configured');
        } else {
          console.log('✓ Master configurations created');
        }
      } catch (e) {
        if (!e.message.includes('no such item')) {
          validationErrors.push(`Could not verify master configurations: ${e.message}`);
        }
      }
    } else {
      // wifi-qcom: No provisioning/configuration objects - CAP interfaces configured in Phase 2.5
      console.log('✓ wifi-qcom mode: CAP interfaces will be configured after CAPs connect');
      console.log('  (Run apply-multiple-devices.js for automatic Phase 2.5 configuration)');
    }

    // Report validation results
    if (validationErrors.length > 0) {
      console.log('\n========================================');
      console.log('✗✗✗ CAPsMAN Controller Configuration FAILED ✗✗✗');
      console.log('========================================');
      console.log('\nValidation errors:');
      for (const error of validationErrors) {
        console.log(`  ✗ ${error}`);
      }
      console.log('\nThe controller may not function correctly.');
      console.log('Please review the errors above and fix the configuration.');
      await mt.close();
      throw new Error(`CAPsMAN validation failed: ${validationErrors.join('; ')}`);
    }

    console.log('\n========================================');
    console.log('✓✓✓ CAPsMAN Controller Configuration Complete! ✓✓✓');
    console.log('========================================');
    console.log('\nCAPsMAN is ready to accept CAP connections.');
    console.log('CAPs should connect to this device\'s IP address.');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ Controller Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

/**
 * Configure device as CAP (Controlled Access Point)
 * Connects to CAPsMAN controller and receives WiFi configuration
 */
async function configureCap(config = {}) {
  const mt = new MikroTikSSH(
    config.host || '192.168.88.1',
    config.username || 'admin',
    config.password || 'admin'
  );

  try {
    await mt.connect();

    console.log('\n========================================');
    console.log('MikroTik CAP (Controlled Access Point) Configuration');
    console.log('========================================\n');

    const capConfig = config.cap || {};
    const controllerAddresses = capConfig.controllerAddresses || [];

    if (controllerAddresses.length === 0) {
      console.log('✗ No controller addresses specified');
      await mt.close();
      return false;
    }

    // Step 0: Set device identity
    await setDeviceIdentity(mt, config);

    // Step 1: Detect WiFi package
    const wifiPackage = await detectWifiPackage(mt);
    if (!wifiPackage) {
      await mt.close();
      return false;
    }

    const capPath = getCapPath(wifiPackage);
    const wifiPath = getWifiPath(wifiPackage);

    // Step 2: Ensure bridge and disable VLAN filtering
    await ensureBridgeInfrastructure(mt);

    // Step 3: Configure management interfaces
    await configureManagementInterfaces(mt, config);
    await configureDisabledInterfaces(mt, config);

    // Step 4: Enable DHCP client
    await enableDhcpClient(mt);

    // Step 4.5: Configure CAPsMAN VLAN (if specified)
    const capsmanVlanIp = await configureCapsmanVlan(mt, config);

    // Step 5: Configure WiFi interfaces for CAPsMAN management
    console.log('\n=== Configuring WiFi Interfaces for CAPsMAN ===');

    const wifiConfig = config.wifi || {};
    const { interface24, interface5 } = await detectRadioLayout(mt);

    // Apply local channel settings (these override controller defaults)
    await applyBandSettings(mt, '2.4GHz', interface24, wifiConfig['2.4GHz'], wifiPath);
    await applyBandSettings(mt, '5GHz', interface5, wifiConfig['5GHz'], wifiPath);

    // Set interfaces to CAPsMAN-managed mode
    try {
      await mt.exec(`${wifiPath} set wifi1 configuration.manager=capsman-or-local`);
      await mt.exec(`${wifiPath} set wifi2 configuration.manager=capsman-or-local`);
      console.log('✓ WiFi interfaces set to CAPsMAN-managed mode');
    } catch (e) {
      console.log(`⚠️  Manager mode: ${e.message}`);
    }

    // Step 6: Enable CAP mode
    console.log('\n=== Enabling CAP Mode ===');

    // Resolve FQDNs to IP addresses (RouterOS caps-man-addresses only accepts IPs)
    const dns = require('dns').promises;
    const resolvedAddresses = [];
    for (const addr of controllerAddresses) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
        resolvedAddresses.push(addr);
        console.log(`✓ Controller IP: ${addr}`);
      } else {
        try {
          const result = await dns.lookup(addr);
          resolvedAddresses.push(result.address);
          console.log(`✓ Resolved ${addr} → ${result.address}`);
        } catch (e) {
          console.log(`⚠️  Could not resolve ${addr}: ${e.message}`);
        }
      }
    }

    if (resolvedAddresses.length === 0) {
      console.log('✗ No valid controller addresses resolved');
      await mt.close();
      return false;
    }

    const addressList = resolvedAddresses.join(',');

    try {
      await mt.exec(`${capPath} set enabled=no`);
    } catch (e) { /* ignore */ }

    try {
      const discoveryInterface = capsmanVlanIp ? 'capsman-vlan' : 'bridge';
      await mt.exec(
        `${capPath} set enabled=yes caps-man-addresses=${addressList} ` +
        `discovery-interfaces=${discoveryInterface}`
      );
      console.log(`✓ CAP enabled, connecting to: ${addressList}`);
      console.log(`✓ Discovery interface: ${discoveryInterface}`);
    } catch (e) {
      console.log(`✗ Failed to enable CAP: ${e.message}`);
    }

    // Step 7: Configure Syslog
    await configureSyslog(mt, config);

    // Step 8: Validate CAP configuration was applied correctly
    console.log('\n=== Validating CAP Configuration ===');
    const validationErrors = [];

    // Check CAP mode is enabled
    try {
      const capStatus = await mt.exec(`${capPath} print`);
      if (!capStatus.includes('enabled: yes') && !capStatus.includes('enabled=yes')) {
        validationErrors.push('CAP mode is not enabled');
      } else {
        console.log('✓ CAP mode is enabled');
      }

      // Check if connected to controller
      if (capStatus.includes('current-caps-man-address:')) {
        const match = capStatus.match(/current-caps-man-address:\s*(\S+)/);
        if (match && match[1] && match[1] !== '') {
          console.log(`✓ Connected to controller: ${match[1]}`);
        } else {
          console.log('⚠️  CAP enabled but not yet connected to controller (may take a moment)');
        }
      }
    } catch (e) {
      validationErrors.push(`Could not verify CAP status: ${e.message}`);
    }

    // Check WiFi interfaces are in CAP-managed mode
    try {
      const wifiStatus = await mt.exec(`${wifiPath} print detail where name=wifi1 or name=wifi2`);
      if (wifiStatus.includes('manager=capsman') || wifiStatus.includes('.manager=capsman')) {
        console.log('✓ WiFi interfaces set to CAPsMAN-managed mode');
      } else if (wifiStatus.includes('managed by CAPsMAN')) {
        console.log('✓ WiFi interfaces are managed by CAPsMAN');
      } else {
        console.log('⚠️  WiFi interfaces may not be in CAPsMAN-managed mode');
      }
    } catch (e) {
      // Non-fatal - just informational
      console.log(`⚠️  Could not verify WiFi interface mode: ${e.message}`);
    }

    // Report validation results
    if (validationErrors.length > 0) {
      console.log('\n========================================');
      console.log('✗✗✗ CAP Configuration FAILED ✗✗✗');
      console.log('========================================');
      console.log('\nValidation errors:');
      for (const error of validationErrors) {
        console.log(`  ✗ ${error}`);
      }
      console.log('\nThe CAP may not connect to the controller correctly.');
      console.log('Please review the errors above and fix the configuration.');
      await mt.close();
      throw new Error(`CAP validation failed: ${validationErrors.join('; ')}`);
    }

    console.log('\n========================================');
    console.log('✓✓✓ CAP Configuration Complete! ✓✓✓');
    console.log('========================================');
    console.log(`\nCAP will connect to CAPsMAN at: ${addressList}`);
    console.log('WiFi configuration will be received from the controller.');

    await mt.close();
    return true;
  } catch (error) {
    console.error('\n✗ CAP Configuration Error:', error.message);
    await mt.close();
    throw error;
  }
}

module.exports = {
  configureController,
  configureCap,
  configureCapInterfacesOnController
};
