# Changelog

## [2.6.2] - 2026-01-09 - Fix WiFi Configuration for wifi-qcom Devices

### Fixed - WiFi-QCOM Package Support (cAP ax and similar devices)
- **Package detection** - Now correctly identifies wifi-qcom package by checking actual installed package name, not just command availability
- **Fast Transition auth types** - wifi-qcom uses `security.ft=yes` parameter instead of `ft-psk` auth type
- **Virtual interface timing** - Added delay after creating virtual interfaces to ensure they register before configuration
- **Special character escaping** - Fixed passphrase handling for special characters (#, !, ^, %, etc.) in double-quoted strings
- **Direct interface naming** - Use direct interface names instead of `[find name=...]` for more reliable configuration

### Bug Fix Details
On devices with `wifi-qcom` package (e.g., cAP ax), both `/interface/wifi` and `/interface/wifiwave2` commands work as aliases. The previous detection logic incorrectly identified these as `wifiwave2` devices, causing:
1. Wrong authentication type syntax (`ft-psk` is not valid on wifi-qcom)
2. Virtual interface configurations not persisting
3. SSIDs not being applied correctly

The fix:
1. Checks `/system package print` for actual package name (`wifiwave2` vs `wifi-qcom`)
2. Uses `security.ft=yes` for Fast Transition on wifi-qcom devices
3. Uses direct interface names for set commands (more reliable than find clauses)
4. Only escapes characters that need escaping in double-quoted strings (`\`, `"`, `$`)

### Related
- GitHub Issue: #1

## [2.6.1] - 2025-10-19 - Fix Old Configuration Persistence

### Fixed - Band Configuration Cleanup
- **Master WiFi interface cleanup** - Fixed issue where old SSIDs persisted when all SSIDs removed from a band
- **Explicit band disabling** - Master interfaces (wifi1, wifi2) now disabled when no SSIDs configured for that band
- **Prevents ghost broadcasts** - Ensures devices don't continue broadcasting old configurations after SSID removal
- Script now tracks band usage and disables unused master interfaces in new Step 4.5

### Bug Fix Details
When removing all SSIDs from a band (e.g., removing all 5GHz SSIDs), the master WiFi interface would remain enabled with its old configuration. This caused devices to continue broadcasting previously configured SSIDs even though they were removed from the YAML configuration.

The fix adds a new cleanup step after SSID configuration that:
1. Checks which bands have zero SSIDs configured
2. Explicitly disables master interfaces for unused bands
3. Prevents old configurations from persisting

### Example Scenario
**Before**: Device configured with 5GHz SSIDs, then updated to only broadcast 2.4GHz
- **Problem**: Old 5GHz SSIDs continued broadcasting
- **Solution**: wifi2 (5GHz master interface) is now disabled when no 5GHz SSIDs are configured

## [2.6.0] - 2025-10-18 - Channel Width Control and Enhanced Backup

### Added - Channel Width Configuration
- **Channel width control** - Configure 2.4GHz and 5GHz channel widths via YAML
- **2.4GHz optimization** - Set to 20MHz to avoid interference in multi-AP deployments
- **5GHz flexibility** - Support for 20/40/80MHz or 20/40/80/160MHz widths
- Channel width settings apply during configuration and preserved in backups
- Automatic width detection and backup from devices

### Enhanced - Roaming Settings Backup
- **Automatic roaming detection** - Backup now detects Fast Transition (802.11r) configuration
- **Complete roaming backup** - All roaming settings (802.11k/v/r) preserved during backup
- Backup intelligently detects FT-enabled WiFi interfaces
- Roaming configuration automatically added to backup YAML when detected

### New YAML Schema Extensions
```yaml
wifi:
  2.4GHz:
    channel: 1
    width: 20mhz            # NEW: Enforce 20MHz for non-overlapping channels
  5GHz:
    channel: 36
    width: 20/40/80mhz      # NEW: Wider channels for better throughput
  roaming:                  # Now backed up automatically
    enabled: yes
    neighborReport: yes
    bssTransition: yes
    fastTransition: yes
```

### Enhanced - Backup Display
- Backup summary now shows channel width settings
- Roaming status displayed in backup output
- Multi-device backup shows roaming as a feature when detected
- Clearer indication of WiFi optimization settings

### Benefits
- **Reduced 2.4GHz interference** - 20MHz channel width prevents overlap
- **Optimal 5GHz performance** - Wider channels improve throughput
- **Complete backup fidelity** - All WiFi settings now preserved
- **Easier multi-AP management** - Consistent width settings across devices

### Use Cases
- **Dense WiFi environments** - 20MHz on 2.4GHz minimizes interference
- **High-performance 5GHz** - 80MHz or 160MHz widths for maximum speed
- **Configuration migration** - Full backup/restore including all WiFi settings
- **Multi-AP consistency** - Ensure all APs use same channel width policy

### Technical Details
- Channel width applies via `channel.width` property in RouterOS v7
- Backup reads width from WiFi interface detail output
- Roaming detection checks for `.ft=yes` flag in WiFi interface configuration
- Width settings validated: `20mhz`, `20/40mhz`, `20/40/80mhz`, `20/40/80/160mhz`

## [2.5.0] - 2025-10-18 - WiFi Optimization and Multi-AP Management

### Added - WiFi Channel & Power Configuration
- **WiFi optimization settings** in YAML schema - Configure channels, TX power, and regulatory domain
- **Channel configuration** - Set specific WiFi channels (2.4GHz: 1-13, 5GHz: 36-165)
- **TX power control** - Adjust transmission power in dBm for optimal coverage
- **Country/regulatory domain** - Ensure compliance with local regulations
- Automatic channel-to-frequency mapping for both 2.4GHz and 5GHz bands
- Settings apply during configuration and are preserved in backups

### Added - Fast Roaming (802.11k/v/r)
- **802.11k** - Radio Resource Management (neighbor reports)
- **802.11v** - BSS Transition Management (client steering)
- **802.11r** - Fast BSS Transition (reduced handoff time)
- Enable seamless roaming between multiple access points
- Configurable per-device via `wifi.roaming` section

### Added - Channel Optimization Tool
- **`diag/optimize-wifi-channels.js`** - Intelligent channel planning for multi-AP deployments
- Analyzes current channel usage across all devices
- Detects channel conflicts (multiple APs on same channel)
- Suggests optimal non-overlapping channels for 3+ device deployments
  - 2.4GHz: Assigns channels 1, 6, 11 (non-overlapping)
  - 5GHz: Assigns channels 36, 52, 149 (well-separated)
- **Dry-run mode** - Preview suggestions without making changes
- **Auto-apply mode** - Automatically update YAML with optimal channels
- Preserves existing TX power and country settings when optimizing

### Enhanced - Backup Functionality
- WiFi optimization settings now exported during backup
- Channel, TX power, and country settings captured from device
- Backup summary displays WiFi optimization status
- Multi-device backups show optimization per device

### New YAML Schema
```yaml
wifi:
  2.4GHz:
    channel: 1              # Channel number (1-13)
    txPower: 15             # TX power in dBm
    country: united_states  # Regulatory domain
  5GHz:
    channel: 36             # Channel number (36-165)
    txPower: 18             # TX power in dBm
    country: united_states
  roaming:
    enabled: yes            # Enable fast roaming
    neighborReport: yes     # 802.11k
    bssTransition: yes      # 802.11v
    fastTransition: yes     # 802.11r
```

### Usage - WiFi Optimization

#### Configure Channels Manually
```bash
# Edit config.yaml to add wifi section
vim config.yaml

# Apply configuration
./apply-config.js config.yaml
```

#### Optimize Multiple APs Automatically
```bash
# Analyze current channel usage (dry-run)
node diag/optimize-wifi-channels.js multiple-devices.yaml

# Apply suggested channels
node diag/optimize-wifi-channels.js multiple-devices.yaml --apply

# Deploy optimized configuration to devices
./apply-multiple-devices.js multiple-devices.yaml
```

### Benefits
- **Reduced interference**: Non-overlapping channels minimize WiFi conflicts
- **Better performance**: Optimal channel spacing improves throughput and reliability
- **Seamless roaming**: Fast handoff between APs for mobile devices
- **Simplified multi-AP deployment**: Automatic channel planning for 3+ devices
- **Compliance**: Country settings ensure regulatory compliance
- **Fine-tuned coverage**: TX power control for optimal signal strength

### Use Cases
- **Office deployments**: Multiple APs on same floor need non-overlapping channels
- **Large homes**: Multiple floors with several APs benefit from roaming
- **Dense environments**: Minimize interference in crowded WiFi spaces
- **Enterprise**: Fast roaming for mobile devices (laptops, phones, tablets)

### Documentation
- Updated `config.example.yaml` with WiFi optimization examples
- Updated `multiple-devices.example.yaml` showing 3-AP optimized deployment
- Added `diag/README.md` documentation for channel optimization tool
- Example configurations show recommended channel assignments

### Technical Details
- RouterOS v7 WiFi property names correctly mapped (`channel.frequency`, `configuration.tx-power`, `configuration.country`)
- Channel-to-frequency conversion for both 2.4GHz (2412-2472 MHz) and 5GHz (5180-5825 MHz)
- Backup function extracts and preserves WiFi settings from device
- Apply function configures all WiFi settings before SSIDs (Step 3 of 5)

## [2.4.0] - 2025-10-18 - Backup and Multi-Device Support

### Added - Backup Functionality
- **Backup tool** (`backup-config.js`) - Export current MikroTik configuration to config.yaml format
- `backupMikroTikConfig()` function in mikrotik-no-vlan-filtering.js library
- Reads current device state including:
  - WiFi SSIDs, passphrases, VLANs, and band assignments
  - WiFi datapath configurations
  - Bridge port assignments (management interfaces)
  - Disabled interface status
- Generates valid config.yaml compatible with apply-config.js
- NPM script: `npm run backup`
- Binary: `mikrotik-backup` (when installed globally)

### Added - Multi-Device Support
- **Multi-device backup tool** (`backup-multiple-devices.js`) - Backup multiple devices to single YAML file
- **Multi-device apply tool** (`apply-multiple-devices.js`) - Configure multiple devices from single YAML file
- Support for sequential (default) and parallel (--parallel) execution modes
- Comprehensive error handling and progress reporting for multi-device operations
- `multiple-devices.yaml` - Example multi-device configuration file
- NPM scripts: `npm run backup-multiple`, `npm run apply-multiple`
- Binaries: `mikrotik-backup-multiple`, `mikrotik-apply-multiple`

### Usage

#### Single Device Backup
```bash
# Backup to default file (config-backup.yaml)
./backup-config.js 192.168.88.1 admin password

# Backup to specific file
./backup-config.js 192.168.88.1 admin password my-backup.yaml

# Or via npm
npm run backup -- 192.168.88.1 admin password config.yaml
```

#### Multi-Device Operations
```bash
# Backup all devices (updates file in-place by default)
./backup-multiple-devices.js multiple-devices.yaml

# Or save to different file
./backup-multiple-devices.js multiple-devices.yaml --output backup.yaml

# Apply configuration to all devices (sequential)
./apply-multiple-devices.js multiple-devices.yaml

# Apply configuration in parallel (faster)
./apply-multiple-devices.js multiple-devices.yaml --parallel
```

**Passphrase Handling:**
- Most WiFi passphrases are successfully extracted from devices during backup
- Some passphrases may appear as `UNKNOWN` if MikroTik doesn't expose them via SSH (depends on RouterOS version/settings)
- You **must** manually edit any `UNKNOWN` passphrases before applying the configuration
- Attempting to apply a configuration with `UNKNOWN` passphrases will fail validation with a clear error message
- This prevents accidentally setting weak or placeholder passwords on production devices

### Fixed
- **Backup parsing bug - SSIDs**: Now correctly captures SSIDs from master WiFi interfaces (was only capturing virtual interfaces)
  - Uses regex to match both full format (`configuration.ssid=`) and shorthand (`.ssid=`) used by master interfaces
  - Passphrases are now extracted correctly from most devices
- **Backup parsing bug - Disabled interfaces**: Now correctly detects disabled ethernet interfaces by parsing the "X" flag
  - Previous code looked for `disabled=yes` in output, but MikroTik shows disabled status as "X" flag
  - Disabled interfaces are properly excluded from managementInterfaces list
  - Fixed for both single-device and multi-device backups

### Benefits
- **Document existing configurations**: Export config from running devices
- **Migration**: Easy transfer of config between devices
- **Version control**: Generate config.yaml for devices configured manually
- **Audit**: Review current device state in YAML format
- **Fleet management**: Configure multiple APs with one command
- **Consistency**: Ensure all devices have identical or custom configurations
- **Efficiency**: Parallel execution for faster deployment

## [2.3.0] - Bug Fixes and Diagnostic Tools

### Added
- **Diagnostic tools folder** (`diag/`) with troubleshooting utilities
- `diag/check-status.js` - View WiFi interfaces, datapaths, and bridge configuration
- `diag/check-running.js` - Monitor runtime status and connected clients
- `diag/README.md` - Documentation for diagnostic tools
- Diagnostic scripts now included in Docker image

### Fixed
- **Bug #2**: `disabledInterfaces` not passed through in apply-config.js
- **Bug #9**: Outdated default `managementInterfaces` (now defaults to `['ether1']`)
- **Bug #7**: Improved error handling - no longer swallows real errors in cleanup
- **Bug #8**: Fixed race condition - datapaths now removed before interfaces

### Improved
- Cleaner repository root - diagnostic scripts organized in dedicated folder
- Better error visibility during configuration cleanup
- More robust cleanup sequence prevents "in use" errors

## [2.2.0] - Interface Management and Topology Improvements

### Added
- **`disabledInterfaces` configuration option** - Disable unused Ethernet interfaces for security
- Interfaces listed in `disabledInterfaces` are automatically disabled during configuration
- Flexible configuration - enable/disable any interface based on your topology

### Changed
- **Single trunk port topology** - ether1 is now the default trunk port (untagged management + tagged VLANs)
- Default `managementInterfaces` changed from `[ether1, ether2]` to `[ether1]`
- ether2 disabled by default for security (can be re-enabled via config)
- Updated network diagram to accurately show single trunk port design
- Added upstream switch to Mermaid diagram for topology clarity

### Improved
- **Security**: Unused interfaces are now disabled by default
- **Documentation**: Clarified VLAN isolation mechanism (WiFi datapaths + upstream switch)
- **Topology**: Better alignment with common deployment scenarios
- Summary output now shows disabled interfaces

### Notes
- **No breaking changes for most users**: If you use ether1 for management, no config changes needed
- **If you use ether2**: Remove it from `disabledInterfaces` and add to `managementInterfaces`
- **VLAN isolation**: Works via WiFi datapaths and upstream switch, not bridge VLAN filtering

## [2.1.3] - GitHub Container Registry Migration

### Changed
- **Breaking Change**: Docker images now published to GitHub Container Registry (ghcr.io)
- Updated all documentation to reference `ghcr.io/nickborgers/mikrotik-as-wap-configurator`
- GitHub Actions workflow now uses GITHUB_TOKEN for authentication
- Updated README badges to point to GitHub Container Registry

### Migration Guide
Update your docker commands from:
```bash
docker run nickborgers/mikrotik-as-wap-configurator
```
to:
```bash
docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator
```

## [2.1.2] - CI/CD Fix

### Fixed
- Fix PAT reference in GitHub Actions pipeline

## [2.1.1] - Production Deployment

### Changed
- Production deployment verification

## [2.1.0] - Configuration Cleanup and Idempotency

### Added
- **Automatic cleanup**: Script now removes old virtual WiFi interfaces and datapaths before applying new configuration
- **Full idempotency**: Device state matches config.yaml exactly - removed SSIDs are cleaned up automatically
- **Ethernet management warning**: Clear documentation that management must be performed via Ethernet, not WiFi

### Fixed
- Old SSIDs no longer persist on device after removal from config.yaml
- Virtual WiFi interfaces are properly cleaned up on each run
- Datapaths are recreated fresh on each configuration apply

## [2.0.0] - Band-Based SSID Configuration

### Changed

**Breaking Change**: Complete redesign of SSID configuration schema to support band-based assignment.

#### Old Schema (v1.0)
```yaml
ssids:
  - name: ssid1-config
    ssid: SSID-1
    vlan: 100
    interface: wifi1
```

#### New Schema (v2.0)
```yaml
ssids:
  - ssid: SSID-1
    passphrase: password
    vlan: 100
    bands:
      - 2.4GHz
      - 5GHz
```

### Added

- **Virtual WiFi interface support**: Multiple SSIDs can now broadcast on the same frequency band
- **WiFi datapath VLAN tagging**: Proper VLAN isolation for WiFi clients
- **Per-SSID passphrases**: Each SSID can now have its own password
- **Band selection**: Choose 2.4GHz, 5GHz, or both for each SSID
- **Multi-VLAN support**: Different SSIDs can be on different VLANs with different passwords
- **Validation**: Configuration validation checks for required fields and valid band names
- **Docker support**: Official Docker image with multi-architecture support (linux/amd64, linux/arm64)
- **Automated publishing**: GitHub Actions workflow for Docker Hub releases
- **Comprehensive documentation**: DOCKER.md, GETTING-STARTED.md, QUICK-REFERENCE.md
- **MIT License**: Open source license added

### Benefits

1. **Intuitive Configuration**: Think in terms of SSIDs and bands, not interfaces
2. **Easier Management**: Same SSID on both bands for seamless roaming
3. **More Flexible**: Different SSIDs can have different passwords and VLANs
4. **Clearer Intent**: Configuration explicitly shows which bands an SSID uses

### Example Use Cases

**Single SSID on both bands (most common):**
```yaml
ssids:
  - ssid: MyNetwork
    passphrase: mypassword
    vlan: 100
    bands: [2.4GHz, 5GHz]
```

**Separate SSIDs for different purposes:**
```yaml
ssids:
  - ssid: Corporate
    passphrase: corp-password
    vlan: 100
    bands: [2.4GHz, 5GHz]

  - ssid: Guest
    passphrase: guest-password
    vlan: 200
    bands: [2.4GHz, 5GHz]

  - ssid: IoT-Devices
    passphrase: iot-password
    vlan: 300
    bands: [2.4GHz]  # Many IoT devices only support 2.4GHz
```

### Migration Guide

To migrate from v1.0 to v2.0 configuration:

1. Remove the `name` field (no longer needed)
2. Remove the `interface` field
3. Add `bands` array with desired bands
4. Move password from global `security.passphrase` to per-SSID `passphrase`

**Before:**
```yaml
security:
  passphrase: password

ssids:
  - name: ssid1-config
    ssid: MyNetwork
    vlan: 100
    interface: wifi1
```

**After:**
```yaml
ssids:
  - ssid: MyNetwork
    passphrase: password
    vlan: 100
    bands: [2.4GHz]
```

## [1.0.0] - Initial Release

- Basic YAML configuration for MikroTik devices
- Interface-based SSID assignment
- Safe configuration without VLAN filtering
- Prevention of device lockouts
