/**
 * MikroTik Configuration Library
 * Facade module re-exporting all public APIs
 */

const { MikroTikSSH } = require('./ssh-client');
const { configureMikroTik } = require('./configure');
const { configureController, configureCap, configureCapInterfacesOnController } = require('./capsman');
const { backupMikroTikConfig } = require('./backup');

module.exports = {
  // Main configuration entry point
  configureMikroTik,

  // CAPsMAN-specific functions
  configureController,
  configureCap,
  configureCapInterfacesOnController,

  // Backup function
  backupMikroTikConfig,

  // SSH client for direct device access
  MikroTikSSH
};
