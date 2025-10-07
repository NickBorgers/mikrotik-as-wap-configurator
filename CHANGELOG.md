# Changelog

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
