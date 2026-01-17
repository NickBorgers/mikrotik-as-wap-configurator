/**
 * MikroTik Configuration Library
 * Facade module re-exporting all public APIs
 */

const { MikroTikSSH } = require('./ssh-client');
const { configureMikroTik } = require('./configure');
const { configureController, configureCap, configureCapInterfacesOnController } = require('./capsman');
const { backupMikroTikConfig } = require('./backup');
const { configureAccessLists, backupAccessLists, extractHostname } = require('./access-list');

module.exports = {
  // Main configuration entry point
  configureMikroTik,

  // CAPsMAN-specific functions
  configureController,
  configureCap,
  configureCapInterfacesOnController,

  // Access-list functions (WAP locking)
  configureAccessLists,
  backupAccessLists,
  extractHostname,

  // Backup function
  backupMikroTikConfig,

  // SSH client for direct device access
  MikroTikSSH
};
