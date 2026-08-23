/**
 * MikroTik Configuration Library
 * Facade module re-exporting all public APIs
 */

const { MikroTikSSH } = require('./ssh-client');
const { configureMikroTik } = require('./configure');
const { configureController, configureCap, configureCapInterfacesOnController, configureLocalCapFallback } = require('./capsman');
const { configureRouter } = require('./router');
const { backupMikroTikConfig } = require('./backup');
const { configureAccessLists, backupAccessLists, extractHostname } = require('./access-list');

module.exports = {
  // Main configuration entry point
  configureMikroTik,

  // Router role (multi-WAN gateway)
  configureRouter,

  // CAPsMAN-specific functions
  configureController,
  configureCap,
  configureCapInterfacesOnController,
  configureLocalCapFallback,

  // Access-list functions (WAP locking)
  configureAccessLists,
  backupAccessLists,
  extractHostname,

  // Backup function
  backupMikroTikConfig,

  // SSH client for direct device access
  MikroTikSSH
};
