# Changelog

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
