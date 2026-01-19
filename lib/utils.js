/**
 * Utility functions for MikroTik configuration
 * Path helpers and string escaping
 */

/**
 * Helper to escape special characters in strings for MikroTik RouterOS commands
 * When strings are enclosed in double quotes, most special characters are safe.
 * Only need to escape: \ (backslash), " (quote), and $ (variable expansion)
 */
function escapeMikroTik(str) {
  if (!str) return str;
  return str
    .replace(/\\/g, '\\\\')  // Backslash first
    .replace(/"/g, '\\"')    // Double quote
    .replace(/\$/g, '\\$');  // Dollar sign (variable expansion)
  // Note: # ! ^ % ? are safe inside double quotes and should NOT be escaped
}

/**
 * Helper to get WiFi command path (wifi-qcom only)
 * @param {string} _wifiPackage - Ignored, kept for API compatibility
 * @param {string} command - Optional subcommand
 * @returns {string} WiFi path
 */
function getWifiPath(_wifiPackage, command) {
  const basePath = '/interface/wifi';
  return command ? `${basePath}/${command}` : basePath;
}

/**
 * Helper to get CAPsMAN command path (wifi-qcom only)
 * @param {string} _wifiPackage - Ignored, kept for API compatibility
 * @param {string} command - Optional subcommand
 * @returns {string} CAPsMAN path
 */
function getCapsmanPath(_wifiPackage, command) {
  const basePath = '/interface/wifi/capsman';
  return command ? `${basePath}/${command}` : basePath;
}

/**
 * Helper to get CAP command path (wifi-qcom only)
 * @param {string} _wifiPackage - Ignored, kept for API compatibility
 * @returns {string} CAP path
 */
function getCapPath(_wifiPackage) {
  return '/interface/wifi/cap';
}

module.exports = {
  escapeMikroTik,
  getWifiPath,
  getCapsmanPath,
  getCapPath
};
