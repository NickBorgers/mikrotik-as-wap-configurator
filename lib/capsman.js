/**
 * CAPsMAN controller and CAP configuration
 * Functions for configuring CAPsMAN controllers and CAP devices
 */

const { MikroTikSSH } = require('./ssh-client');
const { getWifiPath, getCapsmanPath, getCapPath } = require('./utils');
const {
  setDeviceIdentity,
  detectWifiPackage,
  ensureBridgeInfrastructure,
  configureIgmpSnooping,
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
 * @param {Array<Object>} capDeviceConfigs - Array of CAP device configurations (optional)
 *        Each config should have: host, identity, wifi.['2.4GHz'].txPower, wifi.['5GHz'].txPower
 * @returns {boolean} - Success status
 */
async function configureCapInterfacesOnController(config = {}, capDeviceConfigs = []) {
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

    // Detect WiFi package (wifi-qcom only in v5.0.0+)
    const wifiPackage = await detectWifiPackage(mt);
    if (!wifiPackage) {
      console.log('✗ Could not detect WiFi package');
      await mt.close();
      return false;
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

    // Build a map of CAP identity to device config for quick lookup
    // Identity is extracted from hostname (e.g., managed-wap-north.example.com -> managed-wap-north)
    const capDeviceConfigMap = new Map();
    for (const capConfig of capDeviceConfigs) {
      const hostname = capConfig.host || '';
      // Extract identity: either explicit identity or hostname without domain
      const identity = capConfig.identity || hostname.split('.')[0];
      if (identity) {
        capDeviceConfigMap.set(identity, capConfig);
      }
    }

    if (capDeviceConfigs.length > 0) {
      console.log(`\n=== Per-Device WiFi Settings Available ===`);
      for (const [identity, cfg] of capDeviceConfigMap) {
        const tx24 = cfg.wifi?.['2.4GHz']?.txPower;
        const tx5 = cfg.wifi?.['5GHz']?.txPower;
        if (tx24 !== undefined || tx5 !== undefined) {
          console.log(`  ${identity}: 2.4GHz=${tx24 !== undefined ? tx24 + 'dBm' : 'default'}, 5GHz=${tx5 !== undefined ? tx5 + 'dBm' : 'default'}`);
        }
      }
    }

    // Configure each CAP interface
    console.log('\n=== Configuring CAP Interfaces ===');

    for (const capInterface of capInterfaces) {
      const bandSsids = ssidsByBand[capInterface.band];

      if (!bandSsids || bandSsids.length === 0) {
        console.log(`⚠️  No SSIDs configured for ${capInterface.band} (${capInterface.name})`);
        continue;
      }

      // Extract CAP identity from interface name (e.g., managed-wap-north-2g -> managed-wap-north)
      const capIdentity = capInterface.name.replace(/-2g$/, '').replace(/-5g$/, '');
      const capDeviceConfig = capDeviceConfigMap.get(capIdentity);

      // Get band-specific settings (txPower, etc.) from CAP device config
      const bandSettings = capDeviceConfig?.wifi?.[capInterface.band] || {};

      // Configure primary SSID on master interface
      const primarySsid = bandSsids[0];
      console.log(`\nConfiguring ${capInterface.name} with SSID: ${primarySsid.ssid}`);

      await configureWifiInterface(
        mt, wifiPath, capInterface.name, primarySsid, country, bandSettings
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
          mt, wifiPath, virtualName, additionalSsid, country, bandSettings
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

    // Step 2.5: Configure IGMP snooping
    await configureIgmpSnooping(mt, config.igmpSnooping || false);

    // Step 3: Configure management interfaces
    await configureManagementInterfaces(mt, config);
    await configureDisabledInterfaces(mt, config);

    // Step 4: Enable DHCP client
    await enableDhcpClient(mt);

    // Step 4.5: Configure CAPsMAN VLAN (if specified)
    await configureCapsmanVlan(mt, config);

    // wifi-qcom CAPsMAN Mode (v5.0.0+: wifi-qcom only)
    // wifi-qcom doesn't support configuration/provisioning objects
    // CAP interfaces are configured directly after CAPs connect (Phase 2.5)
    console.log('\n=== CAPsMAN Mode (wifi-qcom) ===');
    console.log('ℹ️  CAP interfaces will be configured after CAPs connect (Phase 2.5).');
    console.log(`ℹ️  SSIDs to configure: ${ssids.map(s => s.ssid).join(', ')}`);
    const wifiConfig = config.wifi || {};

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

    // wifi-qcom: No provisioning/configuration objects - CAP interfaces configured in Phase 2.5
    console.log('✓ CAP interfaces will be configured after CAPs connect (Phase 2.5)');
    console.log('  (Run apply-multiple-devices.js for automatic Phase 2.5 configuration)');

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

    // Support unified format (capsman.*) and legacy format (cap.*)
    const capsmanConfig = config.capsman || {};
    const legacyCapConfig = config.cap || {};
    const controllerAddresses = capsmanConfig.controllerAddresses || legacyCapConfig.controllerAddresses || [];

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

    // Step 2.5: Configure IGMP snooping
    await configureIgmpSnooping(mt, config.igmpSnooping || false);

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
      // Enable slaves-static for wifi-qcom to allow local virtual interfaces to be
      // managed by CAPsMAN. Without this, virtual SSIDs don't have data plane traffic.
      // See: https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/5
      await mt.exec(
        `${capPath} set enabled=yes caps-man-addresses=${addressList} ` +
        `discovery-interfaces=${discoveryInterface} slaves-static=yes`
      );
      console.log(`✓ CAP enabled, connecting to: ${addressList}`);
      console.log(`✓ Discovery interface: ${discoveryInterface}`);
      console.log(`✓ Slaves-static enabled for virtual SSID support`);
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

/**
 * Configure local WiFi fallback on CAP devices
 * This enables CAPs to continue providing WiFi service even when
 * the CAPsMAN controller is unreachable. Since CAPs use 'capsman-or-local'
 * manager mode, they automatically fall back to local config.
 *
 * @param {Object} capConfig - CAP device configuration
 * @param {string} capConfig.host - CAP hostname/IP
 * @param {string} capConfig.username - SSH username
 * @param {string} capConfig.password - SSH password
 * @param {Object} capConfig.wifi - Per-CAP WiFi settings (txPower, channel per band)
 * @param {Array<Object>} ssids - Deployment-level SSIDs to configure
 * @param {string} country - WiFi country code
 * @returns {boolean} - Success status
 */
async function configureLocalCapFallback(capConfig, ssids, country) {
  const mt = new MikroTikSSH(
    capConfig.host || '192.168.88.1',
    capConfig.username || 'admin',
    capConfig.password || 'admin'
  );

  try {
    await mt.connect();

    const identity = capConfig.identity || capConfig.host.split('.')[0];
    console.log(`\n--- Configuring Local WiFi Fallback: ${identity} ---`);

    if (!ssids || ssids.length === 0) {
      console.log('⚠️  No SSIDs to configure for local fallback');
      await mt.close();
      return true;
    }

    // Detect WiFi package
    const wifiPackage = await detectWifiPackage(mt);
    if (!wifiPackage) {
      console.log('✗ Could not detect WiFi package');
      await mt.close();
      return false;
    }

    const wifiPath = getWifiPath(wifiPackage);

    // Detect radio layout (wifi1 = 2.4GHz or 5GHz depending on device)
    const { interface24, interface5 } = await detectRadioLayout(mt);
    const bandToInterface = {
      '2.4GHz': interface24,
      '5GHz': interface5
    };

    // Clean up old datapaths and virtual interfaces for idempotency
    console.log('\n=== Cleaning Up Old Local Configurations ===');

    // Remove datapaths first (to avoid "in use" errors)
    const datapathPath = `${wifiPath}/datapath`;
    try {
      const datapaths = await mt.exec(`${datapathPath} print terse where name~"wifi"`);
      if (datapaths && datapaths.trim()) {
        await mt.exec(`${datapathPath} remove [find name~"wifi"]`);
        console.log('✓ Removed old WiFi datapaths');
      } else {
        console.log('✓ No datapaths to remove');
      }
    } catch (e) {
      if (e.message.includes('no such') || e.message.includes('not found')) {
        console.log('✓ No datapaths to remove');
      } else {
        console.log(`⚠️  Could not remove datapaths: ${e.message}`);
      }
    }

    // Remove virtual WiFi interfaces
    try {
      const virtualInterfaces = await mt.exec(`${wifiPath} print terse where master-interface`);
      if (virtualInterfaces && virtualInterfaces.trim()) {
        await mt.exec(`${wifiPath} remove [find master-interface]`);
        console.log('✓ Removed old virtual WiFi interfaces');
      } else {
        console.log('✓ No virtual interfaces to remove');
      }
    } catch (e) {
      if (e.message.includes('no such') || e.message.includes('not found')) {
        console.log('✓ No virtual interfaces to remove');
      } else {
        console.log(`⚠️  Could not remove virtual interfaces: ${e.message}`);
      }
    }

    // Group SSIDs by band
    const ssidsByBand = {
      '2.4GHz': ssids.filter(s => s.bands && s.bands.includes('2.4GHz')),
      '5GHz': ssids.filter(s => s.bands && s.bands.includes('5GHz'))
    };

    // Configure WiFi interfaces
    console.log('\n=== Configuring Local WiFi Interfaces ===');

    const wifiConfig = capConfig.wifi || {};

    for (const [band, bandSsids] of Object.entries(ssidsByBand)) {
      if (bandSsids.length === 0) continue;

      const masterInterface = bandToInterface[band];
      const bandSettings = wifiConfig[band] || {};

      // Apply band settings (channel, txPower) to master interface
      await applyBandSettings(mt, band, masterInterface, bandSettings, wifiPath);

      // Configure primary SSID on master interface
      const primarySsid = bandSsids[0];
      console.log(`\nConfiguring ${masterInterface} (${band}) with SSID: ${primarySsid.ssid}`);

      await configureWifiInterface(
        mt, wifiPath, masterInterface, primarySsid, country, bandSettings
      );

      // Create virtual interfaces for additional SSIDs on same band
      for (let i = 1; i < bandSsids.length; i++) {
        const additionalSsid = bandSsids[i];
        const virtualName = `${masterInterface}-ssid${i + 1}`;

        console.log(`\nCreating virtual interface ${virtualName} for SSID: ${additionalSsid.ssid}`);

        try {
          await mt.exec(`${wifiPath} add master-interface=${masterInterface} name="${virtualName}"`);
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
          mt, wifiPath, virtualName, additionalSsid, country, bandSettings
        );

        // Add virtual interface as bridge port with correct PVID
        // This is required for wifi-qcom CAPsMAN "traffic processing on CAP" mode.
        // Without this, virtual SSID traffic doesn't bridge properly.
        // See: https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/5
        const vlan = additionalSsid.vlan;
        try {
          // Remove existing bridge port if present (for idempotency)
          await mt.exec(`/interface/bridge/port remove [find interface="${virtualName}"]`);
        } catch (e) {
          // Ignore if not found
        }
        try {
          await mt.exec(`/interface/bridge/port add interface=${virtualName} bridge=bridge pvid=${vlan}`);
          console.log(`  ✓ Added ${virtualName} to bridge with PVID=${vlan}`);
        } catch (e) {
          if (e.message.includes('already')) {
            // Update PVID on existing port
            try {
              await mt.exec(`/interface/bridge/port set [find interface="${virtualName}"] pvid=${vlan}`);
              console.log(`  ✓ Updated ${virtualName} bridge port PVID=${vlan}`);
            } catch (e2) {
              console.log(`  ⚠️  Could not set PVID for ${virtualName}: ${e2.message}`);
            }
          } else {
            console.log(`  ⚠️  Could not add ${virtualName} to bridge: ${e.message}`);
          }
        }
      }
    }

    // Disable unused bands
    for (const [band, bandSsids] of Object.entries(ssidsByBand)) {
      if (bandSsids.length === 0) {
        const masterInterface = bandToInterface[band];
        try {
          await mt.exec(`${wifiPath} set ${masterInterface} disabled=yes`);
          console.log(`✓ Disabled ${masterInterface} (${band}) - no SSIDs configured`);
        } catch (e) {
          console.log(`⚠️  Could not disable ${masterInterface}: ${e.message}`);
        }
      }
    }

    // After configuring local interfaces, restart CAP mode to force CAPsMAN rebind.
    // CAPsMAN needs to rebind to the newly created/updated local static interfaces.
    // Without this, virtual interfaces remain "Inactive" and traffic doesn't flow.
    // See: https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/5
    console.log('\n=== Restarting CAP Mode for CAPsMAN Rebind ===');

    const capPath = getCapPath(wifiPackage);

    try {
      console.log('  Disabling CAP mode...');
      await mt.exec(`${capPath} set enabled=no`);
      await new Promise(r => setTimeout(r, 2000));

      console.log('  Re-enabling CAP mode with slaves-static=yes...');
      await mt.exec(`${capPath} set enabled=yes slaves-static=yes`);

      // Wait for CAPsMAN to rebind virtual interfaces
      console.log('  Waiting for CAPsMAN to rebind virtual interfaces...');
      const maxWaitMs = 15000;
      const checkIntervalMs = 2000;
      let elapsed = 0;
      let boundCount = 0;

      while (elapsed < maxWaitMs) {
        await new Promise(r => setTimeout(r, checkIntervalMs));
        elapsed += checkIntervalMs;

        // Check how many virtual interfaces are bound
        const wifiStatus = await mt.exec(`${wifiPath} print where master-interface`);
        boundCount = (wifiStatus.match(/managed by CAPsMAN/g) || []).length;
        const totalVirtual = wifiStatus.trim().split('\n').filter(l => l.includes('ssid')).length;

        if (boundCount > 0) {
          console.log(`  ✓ CAPsMAN rebind successful: ${boundCount} virtual interface(s) bound`);
          break;
        }

        console.log(`  ... waiting (${elapsed/1000}s) - ${boundCount}/${totalVirtual} interfaces bound`);
      }

      if (boundCount === 0) {
        console.log('  ⚠️  CAPsMAN rebind timeout - virtual interfaces may not be active yet');
        console.log('      Clients should still work once CAPsMAN completes provisioning');
      }
    } catch (e) {
      console.log(`  ⚠️  CAP restart warning: ${e.message}`);
    }

    console.log(`\n✓ Local WiFi fallback configured for ${identity}`);

    await mt.close();
    return true;
  } catch (error) {
    console.error(`\n✗ Local WiFi Fallback Error for ${capConfig.host}: ${error.message}`);
    await mt.close();
    return false;  // Non-fatal - continue with other CAPs
  }
}

module.exports = {
  configureController,
  configureCap,
  configureCapInterfacesOnController,
  configureLocalCapFallback
};
