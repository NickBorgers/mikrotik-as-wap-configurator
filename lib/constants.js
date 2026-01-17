/**
 * Constants for MikroTik WiFi configuration
 * Band mappings and frequency/channel lookup tables
 */

// Map band names to interface names (will be updated based on detected package)
const BAND_TO_INTERFACE = {
  '2.4GHz': 'wifi1',
  '5GHz': 'wifi2'
};

// Channel to frequency maps (avoid duplication)
const CHANNEL_FREQ_24GHZ = {
  1: 2412, 2: 2417, 3: 2422, 4: 2427, 5: 2432, 6: 2437,
  7: 2442, 8: 2447, 9: 2452, 10: 2457, 11: 2462, 12: 2467, 13: 2472
};

const CHANNEL_FREQ_5GHZ = {
  36: 5180, 40: 5200, 44: 5220, 48: 5240,
  52: 5260, 56: 5280, 60: 5300, 64: 5320,
  100: 5500, 104: 5520, 108: 5540, 112: 5560, 116: 5580, 120: 5600, 124: 5620, 128: 5640,
  132: 5660, 136: 5680, 140: 5700, 144: 5720,
  149: 5745, 153: 5765, 157: 5785, 161: 5805, 165: 5825
};

// Inverse maps for backup (frequency -> channel)
const FREQ_CHANNEL_24GHZ = Object.fromEntries(
  Object.entries(CHANNEL_FREQ_24GHZ).map(([k, v]) => [v, parseInt(k)])
);
const FREQ_CHANNEL_5GHZ = Object.fromEntries(
  Object.entries(CHANNEL_FREQ_5GHZ).map(([k, v]) => [v, parseInt(k)])
);

module.exports = {
  BAND_TO_INTERFACE,
  CHANNEL_FREQ_24GHZ,
  CHANNEL_FREQ_5GHZ,
  FREQ_CHANNEL_24GHZ,
  FREQ_CHANNEL_5GHZ
};
