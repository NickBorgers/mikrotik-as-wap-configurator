#!/usr/bin/env node

/**
 * Safe MikroTik Configuration - No VLAN Filtering
 *
 * This configuration achieves VLAN isolation for WiFi clients WITHOUT
 * enabling bridge VLAN filtering, eliminating the risk of lockout.
 *
 * New YAML Schema:
 * - SSIDs defined by name, not interface
 * - Each SSID can specify bands: 2.4GHz, 5GHz, or both
 * - Per-SSID passphrases and VLANs
 *
 * Features:
 * - Automatic device identity from FQDN hostnames
 * - WiFi optimization (channel, power, roaming)
 * - Multi-device configuration support
 *
 * This file re-exports all public APIs from the modular lib/ directory.
 * See lib/ for implementation details.
 */

const lib = require('./lib');

// Re-export all public APIs for backward compatibility
module.exports = {
  configureMikroTik: lib.configureMikroTik,
  configureController: lib.configureController,
  configureCap: lib.configureCap,
  configureCapInterfacesOnController: lib.configureCapInterfacesOnController,
  configureLocalCapFallback: lib.configureLocalCapFallback,
  configureAccessLists: lib.configureAccessLists,
  backupAccessLists: lib.backupAccessLists,
  extractHostname: lib.extractHostname,
  backupMikroTikConfig: lib.backupMikroTikConfig,
  MikroTikSSH: lib.MikroTikSSH
};

// Allow direct execution
if (require.main === module) {
  lib.configureMikroTik().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}
