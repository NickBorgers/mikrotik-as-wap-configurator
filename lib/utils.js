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
 * Helper to get correct WiFi command path based on package type
 */
function getWifiPath(wifiPackage, command) {
  const basePath = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2' : '/interface/wifi';
  return command ? `${basePath}/${command}` : basePath;
}

/**
 * Helper to get CAPsMAN command path based on package type
 */
function getCapsmanPath(wifiPackage, command) {
  const basePath = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2/capsman' : '/interface/wifi/capsman';
  return command ? `${basePath}/${command}` : basePath;
}

/**
 * Helper to get CAP command path based on package type
 */
function getCapPath(wifiPackage) {
  return wifiPackage === 'wifiwave2' ? '/interface/wifiwave2/cap' : '/interface/wifi/cap';
}

module.exports = {
  escapeMikroTik,
  getWifiPath,
  getCapsmanPath,
  getCapPath
};
