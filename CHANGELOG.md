# Changelog

## [4.4.1] - 2026-01-17 - Fix Docker Build

### Fixed - Docker Image Missing lib/ Directory
- **Bug**: Docker images since v4.3.2 were broken - missing `lib/` directory
- **Symptom**: `Error: Cannot find module './lib'` when running Docker image
- **Root cause**: Dockerfile was not updated when code was modularized in v4.3.2
- **Fix**: Added `COPY lib ./lib` to Dockerfile
- Also added missing `backup-config.js` and `backup-multiple-devices.js` to Docker image

## [4.4.0] - 2026-01-17 - WAP Locking via Access-List Rules

### Added - WAP Locking Feature
- **Lock WiFi clients to specific APs** - Prevent stationary devices from roaming unnecessarily
- **YAML-based configuration** - Define `lockedDevices` per device in `multiple-devices.yaml`
- **Automatic rule generation** - Creates ACCEPT rules on target AP and REJECT rules on all others
- **SSID-specific locking** - Optionally lock to specific SSID only, or all SSIDs the AP serves
- **Idempotent operation** - Removes existing rules for MAC before creating new ones

### Use Cases
- **Sonos speakers** - Prevent audio dropouts from unnecessary roaming
- **IoT devices** - Keep stationary devices like SPAN panels, Powerwalls on nearest AP
- **Smart home devices** - Ensure reliable connectivity for devices that shouldn't roam

### Configuration
```yaml
devices:
  - device:
      host: shed-wap.nickborgers.net
    role: cap
    lockedDevices:
      - hostname: sonos-barn        # Human-readable name
        mac: "80:4A:F2:8B:D2:FA"    # Client MAC address
        ssid: PartlySonos           # Optional: specific SSID only
      - hostname: smart-thermostat  # No ssid = all SSIDs
        mac: "48:A6:B8:8E:49:2C"
```

### Implementation Details
- **Phase 2.75** - New deployment phase after CAP interface configuration
- **Rules on controller** - Access-list rules stored on CAPsMAN controller
- **Backup support** - `backup-multiple-devices.js` reads rules and distributes to target device configs
- **Debug command**: `/interface/wifi/access-list print detail` on controller

### Files Added/Modified
- `lib/access-list.js` - NEW: Core access-list logic (`configureAccessLists`, `backupAccessLists`)
- `lib/index.js` - Export new functions
- `lib/backup.js` - Add access-list backup step
- `apply-multiple-devices.js` - Add Phase 2.75 for access-list configuration
- `backup-multiple-devices.js` - Distribute locked devices to target device configs
- `mikrotik-no-vlan-filtering.js` - Re-export new functions
- `multiple-devices.example.yaml` - Add lockedDevices example
- `CLAUDE.md` - Document the feature

### Verification
After applying, check rules on controller:
```
/interface/wifi/access-list print detail
# Shows ACCEPT rules for target APs, REJECT rules for all others
```

## [4.3.10] - 2026-01-17 - Fix DHCP Client Removal for LACP Bond Slaves

### Fixed - Invalid DHCP Clients on Bond Slave Interfaces
- **Bug**: When configuring LACP bonds, the default DHCP client on ether1 becomes invalid but wasn't removed
- **Symptom**: Devices with LACP bonds lose internet connectivity - pings fail, DNS resolution fails, software updates fail
- **Root cause**: MikroTik marks DHCP clients on slave interfaces as invalid, but they still obtain IP addresses and create duplicate routes, causing incorrect source address selection
- **Impact**: Affected devices with LACP bonding (typically those with redundant uplinks)

### Solution
When configuring LACP bonds, the script now removes DHCP clients from bond member interfaces before making them slaves. This prevents:
1. Invalid DHCP clients obtaining IP addresses on slave interfaces
2. Duplicate default routes causing ECMP behavior
3. Wrong source address selection for outbound traffic

### Technical Details
- DHCP clients cannot run on slave/passthrough interfaces in MikroTik
- Even when marked as INVALID, the DHCP client was still receiving an IP and creating routes
- The duplicate routes caused the device to use the slave interface's IP as source address
- Upstream routers/gateways wouldn't respond to traffic from the unexpected source IP

### Files Modified
- `lib/configure.js` - Added DHCP client removal step before bond creation
- `lib/infrastructure.js` - Added DHCP client removal step in `configureLacpBond()`

### Verification
After applying configuration, devices should have only one DHCP client (on bridge):
```
/ip/dhcp-client print
# INTERFACE  USE-PEER-DNS  ADD-DEFAULT-ROUTE  STATUS  ADDRESS
0 bridge     yes           yes                bound   10.x.x.x/24
```

## [4.3.9] - 2026-01-17 - Apply Transition Threshold to wifi-qcom Steering Profiles

### Fixed - Transition Threshold Not Applied (Issue 006)
- **Bug**: The `transitionThreshold` value from YAML configuration was not being applied to wifi-qcom steering profiles
- **Symptom**: 802.11v BSS Transition Management didn't have proper signal thresholds configured
- **Root cause**: The steering profile creation only set `rrm` and `wnm` properties, missing the `transition-threshold` parameter

### Solution
When creating wifi-qcom steering profiles with WNM enabled, now also set the `transition-threshold` parameter:
1. Create steering profile with `rrm` and `wnm` settings
2. Set `transition-threshold` separately (MikroTik quirk: can't be in add command)
3. Handles gracefully on older RouterOS versions that may not support the parameter

### Important Note
Unsolicited 802.11v BSS transition management (which uses `transition-threshold`) requires **RouterOS 7.21beta2 or newer**. On earlier versions (like 7.18.x), the parameter is accepted but may not be functional until firmware is upgraded.

### Example Log Output
```
Configuring far-bedroom-wap-2g with SSID: PartlyPrimary
  ✓ Configured far-bedroom-wap-2g: SSID="PartlyPrimary", VLAN=100, 802.11r, 802.11k, 802.11v(-80dBm)

Creating virtual interface far-bedroom-wap-2g-ssid3 for SSID: PartlyIoT
  ✓ Configured far-bedroom-wap-2g-ssid3: SSID="PartlyIoT", VLAN=100, 802.11r, 802.11k, 802.11v(-75dBm)
```

### Files Modified
- `lib/wifi-config.js` - Added transition-threshold setting to steering profile creation

### Related
- Fixes issue 006 (Transition Threshold Not Applied)
- Transition thresholds: PartlyPrimary/PartlyWork: -80 dBm, PartlyIoT: -75 dBm

## [4.3.8] - 2026-01-17 - Fix Virtual Interface Master-Interface References After Rename

### Fixed - Controller Virtual Interface master-interface References Swapped
- **Bug**: After master interface renaming (v4.3.1 feature), virtual interfaces had incorrect `master-interface` references
- **Symptom**: Interfaces named `-2g-ssidX` pointed to `-5g` master interfaces and vice versa
- **Root cause**: When master interfaces are swapped, MikroTik updates the virtual's `master-interface` property to follow the renamed master, but the virtual interface NAME is not updated
- **Example**: After swap, `cap-2g-ssid2` with `master-interface=cap-5g` (name says 2g, master says 5g)

### Solution
After swapping master interface names, also rename virtual interfaces to match their (renamed) masters:
1. Find all virtual interfaces for the swapped CAP identity
2. Compare virtual interface name band (`-2g-` or `-5g-`) with master-interface band
3. If mismatched, rename virtual interface to match its master

### Example Log Output
```
=== Renaming interfaces for managed-wap-north ===
  ✓ managed-wap-north-2g → managed-wap-north-swap-temp (temp)
  ✓ managed-wap-north-5g → managed-wap-north-2g
  ✓ managed-wap-north-swap-temp → managed-wap-north-5g
  Checking 4 virtual interface(s) for managed-wap-north...
  ✓ Virtual: managed-wap-north-2g-ssid2 → managed-wap-north-5g-ssid2
  ✓ Virtual: managed-wap-north-2g-ssid3 → managed-wap-north-5g-ssid3
```

### Files Modified
- `lib/wifi-config.js` - Added `renameVirtualInterfacesForSwappedMasters()` function

### Related
- Completes fix for issue 005 (Controller Virtual Interface master-interface References Swapped)
- Related to v4.3.1 CAPsMAN Radio Detection & Interface Renaming feature

## [4.3.7] - 2026-01-17 - Fix TX Power Not Applied on CAP Interfaces

### Fixed - Per-Device TX Power in CAPsMAN Phase 2.5
- **TX power now applied correctly to CAP interfaces** during Phase 2.5 configuration
- Per-device `wifi.2.4GHz.txPower` and `wifi.5GHz.txPower` settings are now passed from CAP device configs to the controller when configuring CAP interfaces

### Root Cause
The `configureCapInterfacesOnController()` function was only receiving the controller's configuration, not the individual CAP device configurations. This meant per-device settings like `txPower` were never applied to CAP interfaces.

### Technical Details
**Problem:** CAP interfaces like `managed-wap-north-2g` were not receiving their configured TX power values.

**Solution:**
1. Modified `configureCapInterfacesOnController()` to accept an array of CAP device configs
2. Updated `apply-multiple-devices.js` to pass CAP device configs (host, identity, wifi) to Phase 2.5
3. Extended `configureWifiInterface()` to accept and apply `bandSettings.txPower`
4. CAP identity is extracted from interface name (e.g., `managed-wap-north-2g` → `managed-wap-north`) to look up the correct device config

### Files Modified
- `lib/capsman.js` - Accept `capDeviceConfigs` array, pass band settings to interface configuration
- `lib/wifi-config.js` - Accept `bandSettings` parameter, apply `configuration.tx-power` when specified
- `apply-multiple-devices.js` - Build and pass CAP device configs to Phase 2.5

### Example
With this fix, a CAP configuration like:
```yaml
- device:
    host: managed-wap-north.nickborgers.net
  role: cap
  wifi:
    2.4GHz:
      txPower: 10
```

Now correctly results in:
```
managed-wap-north-2g configuration.tx-power=10
```

## [4.3.6] - 2026-01-17 - Consolidate wifi-qcom/wifiwave2 Handling

### Refactored - WiFi Package Detection and Path Handling
- **Consolidated duplicate code** - `lib/configure.js` now uses centralized helpers instead of inline logic
- **Uses `detectWifiPackage()`** from `lib/infrastructure.js` instead of duplicate detection code
- **Uses `getWifiPath()`** from `lib/utils.js` instead of scattered inline ternary expressions
- **Removed dead code** - Removed unreachable 'wireless' package branch (legacy package not supported)

### Technical Details
The codebase had two patterns for handling wifi-qcom vs wifiwave2:
1. **Good pattern** (in lib/utils.js, lib/infrastructure.js, lib/capsman.js): Centralized helpers
2. **Scattered pattern** (in lib/configure.js): Duplicate detection and inline path construction

This release consolidates to the good pattern:

**Before (duplicate detection in configure.js):**
```javascript
const packages = await mt.exec('/system package print terse where name~"wifi"');
if (packages.includes('wifiwave2')) { ... }
else if (packages.includes('wifi-qcom')) { ... }
const wifiCmd = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2' : '/interface/wifi';
```

**After (using centralized helpers):**
```javascript
const wifiPackage = await detectWifiPackage(mt);
const wifiCmd = getWifiPath(wifiPackage);
```

### Files Modified
- `lib/configure.js` - Refactored to use centralized `detectWifiPackage()` and `getWifiPath()`
- `lib/wifi-config.js` - Updated comment for clarity on security.ft usage

### Benefits
- Single source of truth for package detection logic
- Easier maintenance when package behavior changes
- Cleaner, more readable code in configure.js
- Reduced code duplication across modules

## [4.3.5] - 2026-01-17 - Add 802.11k (RRM) and 802.11v (WNM) Support

### Added - 802.11k/v Support for wifi-qcom and Standalone Modes
- **802.11k (RRM)** - Radio Resource Management / Neighbor Reports
- **802.11v (WNM)** - Wireless Network Management / BSS Transition
- Support added to both CAPsMAN (wifi-qcom) and standalone configurations
- Steering profiles created automatically when RRM or WNM is enabled

### Technical Details - wifi-qcom Steering Profiles
wifi-qcom requires steering configuration as separate profile objects, not inline properties:

```bash
# Steering profile created per interface
/interface/wifi/steering add name="steering-shed-wap-2g" rrm=yes wnm=yes

# Interface references the profile
/interface/wifi set shed-wap-2g steering="steering-shed-wap-2g" ...
```

### Configuration
```yaml
ssids:
  - ssid: MyNetwork
    passphrase: password
    vlan: 100
    bands: [2.4GHz, 5GHz]
    roaming:
      fastTransition: true  # 802.11r
      rrm: true             # 802.11k - NEW
      wnm: true             # 802.11v - NEW
      transitionThreshold: -80  # Signal threshold for steering
```

### Files Modified
- `lib/wifi-config.js` - Added steering profile creation for CAP interfaces
- `lib/configure.js` - Added steering profile creation for standalone mode

### Verification
Steering profiles visible on controller:
```
/interface/wifi/steering print
  - steering-shed-wap-2g rrm=yes wnm=yes
  - steering-shed-wap-2g-ssid3 rrm=yes wnm=yes
  - ...
```

Interface references steering profile:
```
/interface/wifi get shed-wap-2g steering
steering=steering-shed-wap-2g
```

## [4.3.4] - 2026-01-17 - Fix 802.11r Incorrectly Enabled on SSIDs Without Roaming

### Fixed - Fast Transition (802.11r) Applied to SSIDs Without Roaming Configuration
- **Bug**: SSIDs without `roaming.fastTransition` were still getting 802.11r enabled
- **Symptom**: PartlySonos SSID (no roaming configured) had `.ft=yes` on most devices
- **Root cause**: `configureWifiInterface()` in `lib/wifi-config.js` only added `.ft=yes` when enabled, but didn't explicitly set `.ft=no` when disabled
- **Impact**: Stationary devices like Sonos could experience unnecessary roaming behavior

### Affected Devices
- All wifi-qcom CAPsMAN CAP devices
- Example SSIDs: PartlySonos (should have NO roaming, was getting 802.11r)

### Solution
- Explicitly set `security.ft=no security.ft-over-ds=no` when SSID does not have `roaming.fastTransition: true`
- Ensures any previous FT settings are cleared
- Matches behavior of standalone configuration in `lib/configure.js`

### Example
YAML configuration:
```yaml
- ssid: PartlySonos
  passphrase: password
  vlan: 100
  bands: [2.4GHz]
  # No roaming - Sonos devices are stationary
```

Before fix:
```
security.authentication-types=wpa2-psk .passphrase="password" .ft=yes
```

After fix:
```
security.authentication-types=wpa2-psk .passphrase="password" .ft=no
```

## [4.3.3] - 2026-01-17 - Fix Missing SSIDs on CAP Devices

### Fixed - CAP Virtual Interface Cleanup
- **Bug**: CAP devices were missing SSIDs that should be broadcast according to YAML configuration
- **Symptom**: Only some SSIDs appeared on CAP devices (e.g., only 1 of 4 SSIDs on 2.4GHz)
- **Root cause**: `configureCapInterfacesOnController()` did not clean up existing virtual interfaces before creating new ones
- **Impact**: Running configuration multiple times left stale virtual interfaces, causing inconsistent SSID configurations

### Affected Devices
- All wifi-qcom CAP devices using CAPsMAN Phase 2.5 configuration
- Examples: shed-wap, outdoor-wap-east, outdoor-wap-north

### Solution
- Added cleanup step that removes existing virtual interfaces for each CAP master interface before configuration
- Ensures idempotent operation - running multiple times produces consistent results
- Mirrors the cleanup behavior already present in standalone configuration

### Example Log Output
```
=== Cleaning Up Old CAP Virtual Interfaces ===
  ✓ Removed 3 virtual interface(s) from shed-wap-2g
  ✓ Removed 1 virtual interface(s) from shed-wap-5g

=== Configuring CAP Interfaces ===
Configuring shed-wap-2g with SSID: PartlyPrimary
  ✓ Configured shed-wap-2g: SSID="PartlyPrimary", VLAN=100

Creating virtual interface shed-wap-2g-ssid2 for SSID: PartlySonos
  ✓ Created virtual interface shed-wap-2g-ssid2
  ✓ Configured shed-wap-2g-ssid2: SSID="PartlySonos", VLAN=200
```

## [4.3.2] - 2026-01-17 - Modular Code Refactoring

### Changed - Code Organization
- **Refactored monolithic file** - Split 3,051-line `mikrotik-no-vlan-filtering.js` into 9 logical modules
- **New `lib/` directory** containing:
  - `constants.js` - Band maps, frequency/channel lookup tables
  - `utils.js` - Path helpers, string escaping utilities
  - `ssh-client.js` - MikroTikSSH class for device connectivity
  - `infrastructure.js` - Bridge, DHCP, bonding, syslog configuration
  - `wifi-config.js` - Radio detection, band settings, interface configuration
  - `capsman.js` - CAPsMAN controller/CAP functions
  - `backup.js` - Device backup functionality
  - `configure.js` - Main configureMikroTik entry point
  - `index.js` - Facade re-exporting all public APIs

### Fixed
- **diag/check-device.js** - Fixed incorrect relative path for module import

### Backward Compatibility
- **No breaking changes** - All existing imports continue to work unchanged
- `mikrotik-no-vlan-filtering.js` now re-exports from `lib/index.js`
- All 6 public APIs preserved: `configureMikroTik`, `configureController`, `configureCap`, `configureCapInterfacesOnController`, `backupMikroTikConfig`, `MikroTikSSH`

## [4.3.1] - 2026-01-17 - CAPsMAN Radio Detection & Interface Renaming

### Fixed - CAP Interface Band Detection and Naming
- **Bug**: CAP interfaces were incorrectly named - `-2g` interfaces were actually 5GHz radios (and vice versa)
- **Symptom**: Clients connecting to `<cap>-2g` SSIDs were actually on 5GHz
- **Root cause**: MikroTik names CAP interfaces based on physical interface number, not actual radio band
- **Affected devices**: cAP ax, cAP ac, and some wAP ax units
- **Important discovery**: Even identical board models can have different radio layouts!

### Solution - Automatic Interface Renaming
- **Detect actual bands** via radio hardware query
- **Rename misnamed interfaces** so `-2g` is ALWAYS 2.4GHz and `-5g` is ALWAYS 5GHz
- Virtual interfaces inherit correct naming from master interfaces

### How It Works
1. **Detect actual bands** from `/interface/wifi/radio print detail`
2. **Identify misnamed interfaces** where suffix doesn't match actual band
3. **Swap interface names** using temp name to avoid conflicts:
   ```
   managed-wap-north-2g → managed-wap-north-swap-temp (temp)
   managed-wap-north-5g → managed-wap-north-2g
   managed-wap-north-swap-temp → managed-wap-north-5g
   ```
4. **Configure SSIDs** on correctly-named interfaces

### New Functions
- `getRadioBandMapping()` - Query radio hardware to get actual band for each interface
- `renameCapInterfacesToMatchBand()` - Rename interfaces so suffix matches actual band
- `getSwappedRadioCaps()` - Fallback: identify swapped devices by board type

### Example Log Output
```
ℹ️  managed-wap-north-2g: Actual band is 5GHz (via radio hardware) - will rename

=== Renaming interfaces for managed-wap-north ===
  ✓ managed-wap-north-2g → managed-wap-north-swap-temp (temp)
  ✓ managed-wap-north-5g → managed-wap-north-2g
  ✓ managed-wap-north-swap-temp → managed-wap-north-5g

Found 10 CAP interface(s):
  - managed-wap-north-2g (2.4GHz)  ← Correct!
  - managed-wap-north-5g (5GHz)    ← Correct!
```

## [4.3.0] - 2026-01-16 - wifi-qcom CAPsMAN Support

### Added - wifi-qcom CAPsMAN Direct Interface Configuration
- **wifi-qcom CAPsMAN support** - Fixed CAPsMAN configuration for wifi-qcom devices
- **Problem**: wifi-qcom doesn't support `/interface/wifi/capsman/configuration` or `/provisioning` commands
- **Solution**: Configure CAP-operated interfaces directly on the controller after CAPs connect
- **New Phase 2.5** - Multi-device deployment now includes automatic CAP interface configuration

### New Functions
- `discoverCapInterfaces()` - Discover CAP-operated interfaces on controller by naming pattern
- `configureCapInterfacesOnController()` - Configure CAP interfaces with SSID/security/datapath
- `configureWifiInterface()` - Reusable helper for inline WiFi interface configuration

### How It Works
1. **Phase 1**: Controller enables CAPsMAN service (no configuration/provisioning objects for wifi-qcom)
2. **Phase 2**: CAPs connect to controller, creating CAP interfaces (e.g., `shed-wap-2g`, `indoor-wap-5g`)
3. **Phase 2.5** (NEW): Controller configures each CAP interface directly:
   ```
   /interface/wifi set shed-wap-2g \
       configuration.ssid="MySSID" \
       security.authentication-types=wpa2-psk \
       security.passphrase="..." \
       datapath.bridge=bridge datapath.vlan-id=100 \
       disabled=no
   ```

### Backward Compatibility
- **wifiwave2 devices**: Continue using existing configuration/provisioning approach
- Phase 2.5 automatically detects wifiwave2 and skips (not needed)
- No changes to YAML schema required

## [4.2.0] - 2026-01-16 - Code Simplification & Refactoring

### Changed - Major Code Refactoring
- **Extracted shared helper functions** - Reduced code duplication across `configureMikroTik()`, `configureController()`, and `configureCap()`
- **New reusable helpers** - Added 10 shared helper functions for common operations:
  - `execIdempotent()` - Execute commands with graceful "already exists" handling
  - `execWithWarning()` - Execute commands with warning-level error handling
  - `setDeviceIdentity()` - Set device identity from FQDN hostname
  - `detectWifiPackage()` - Detect WiFiWave2 vs wifi-qcom package
  - `ensureBridgeInfrastructure()` - Create bridge and disable VLAN filtering
  - `configureManagementInterfaces()` - Configure bridge ports and LACP bonds
  - `configureDisabledInterfaces()` - Disable unused Ethernet interfaces
  - `enableDhcpClient()` - Enable DHCP client on bridge
  - `configureSyslog()` - Configure remote syslog
  - `detectRadioLayout()` - Detect WiFi radio layout (standard vs swapped)
  - `applyBandSettings()` - Apply channel/power/country settings per band

### Technical Details
- Reduced `configureController()` from 314 to ~180 lines
- Reduced `configureCap()` from 296 to ~130 lines
- Reduced total file size from 2534 to 2447 lines (~87 lines / 3.4%)
- Eliminated ~150 lines of duplicated try-catch error handling
- Eliminated ~100 lines of duplicated setup code across 3 functions
- All helper functions include JSDoc documentation

### Backward Compatibility
- No changes to YAML schema or API
- All existing configurations work unchanged
- No changes to CLI tools or Docker commands

## [4.1.1] - 2026-01-16 - LACP Bond Support for CAPsMAN

### Fixed - LACP Bond Configuration in CAPsMAN Mode
- **Missing bond support** - `configureController()` and `configureCap()` were not handling LACP bonds
- **Deterministic MAC addresses** - Bonded CAPsMAN devices now use `forced-mac-address` from first interface
- **Shared helper function** - Extracted `configureLacpBond()` for consistent bond configuration across all modes

### Technical Details
- Previously, LACP bonds with deterministic MACs only worked in standalone mode
- CAPsMAN devices with bonds (controller or CAP) would lose their forced MAC if reset and re-provisioned
- Now all three modes (standalone, controller, cap) properly configure bonds with `orig-mac-address`

## [4.1.0] - 2026-01-16 - Dedicated CAPsMAN VLAN & Docker Multi-Device Support

### Added - Docker Multi-Device Support
- **`apply-multiple` command** - Apply configurations to multiple devices from Docker
- **`example-multiple` command** - Output example `multiple-devices.yaml` configuration
- **Full flag support** - Pass `--parallel`, `--delay <secs>`, `--no-delay` to control deployment
- Multi-device configuration is now a first-class Docker feature

### Docker Usage
```bash
# Get example multi-device configuration
docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator example-multiple > multiple-devices.yaml

# Apply to multiple devices (sequential with 5s delay)
docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple

# Apply in parallel (faster, but network-wide outage)
docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple --parallel

# Custom delay between devices
docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple --delay 10
```

### Added - CAPsMAN VLAN for L2 Connectivity
- **Dedicated CAPsMAN VLAN** - Solves wifi-qcom L3 connectivity issues
- **Problem**: wifi-qcom CAPsMAN has issues with L3/IP layer CAP↔Controller connections
- **Solution**: Put all CAP↔Controller traffic on a dedicated L2 VLAN
- **Static IP addressing** - Each device gets a predictable IP on the CAPsMAN VLAN
- **Firewall protection** - Admin access (SSH/HTTP) blocked via CAPsMAN VLAN
- **Only CAPWAP allowed** - UDP 5246-5247 traffic permitted on CAPsMAN VLAN

### New YAML Schema
```yaml
# Deployment-level CAPsMAN VLAN configuration
capsmanVlan:
  vlan: 2525                    # VLAN ID for CAPsMAN traffic
  network: 10.252.50.0/24       # Network for static IP addressing

devices:
  # Controller
  - device:
      host: controller.example.com
    role: controller
    capsmanAddress: 10.252.50.1      # Static IP on CAPsMAN VLAN
    capsman:
      certificate: auto

  # CAP
  - device:
      host: cap1.example.com
    role: cap
    capsmanAddress: 10.252.50.2      # Static IP on CAPsMAN VLAN
    cap:
      controllerAddresses:
        - 10.252.50.1                # Controller's CAPsMAN VLAN IP
```

### Implementation Details
- Creates VLAN interface `capsman-vlan` on bridge
- Assigns static IP with network prefix
- Adds firewall rules (place-before=0 for priority):
  - Allow CAPWAP (UDP 5246-5247) from CAPsMAN VLAN
  - Block all other traffic from CAPsMAN VLAN
- CAPs use `capsman-vlan` as discovery interface when configured
- Backup reads CAPsMAN VLAN config and stores `capsmanAddress` per device

### Backward Compatibility
- `capsmanVlan` is optional - existing CAPsMAN configs work unchanged
- Without `capsmanVlan`, CAPs use bridge interface for discovery (L3 mode)
- CAPsMAN VLAN only used when both `capsmanVlan` and `capsmanAddress` are set

### Rollback
```bash
# Remove CAPsMAN VLAN on a device
/interface vlan remove [find name=capsman-vlan]
/ip firewall filter remove [find comment~"CAPsMAN"]
```

## [4.0.0] - 2026-01-16 - CAPsMAN Support with 802.11r/k/v Roaming

### Added - CAPsMAN Centralized WiFi Management
- **Three device roles**: `standalone` (default), `controller`, `cap`
- **Controller mode**: Runs CAPsMAN service, manages CAP devices, also acts as AP
- **CAP mode**: Receives WiFi configuration from controller, applies local channel overrides
- **Coordinated roaming**: 802.11r/k/v work properly with CAPsMAN coordination

### Added - 802.11k/v Support (CAPsMAN)
- **802.11k (RRM)**: Neighbor reports - APs tell clients about nearby APs
- **802.11v (WNM)**: BSS Transition Management - APs steer weak-signal clients
- **Per-SSID config**: `roaming: { rrm: true, wnm: true, transitionThreshold: -80 }`
- Note: 802.11k/v only effective in CAPsMAN mode, not standalone

### Added - Cross-VLAN/L3 Support
- **No shared broadcast domain needed** - CAPsMAN works over L3 routing
- **DTLS encryption** - CAP-to-controller management traffic encrypted
- **Certificate authentication** - Optional mutual certificate auth for security
- **Firewall**: Allow UDP 5246-5247 from CAP management VLANs to controller

### Added - Controller-First Deployment
- `apply-multiple-devices.js` auto-detects CAPsMAN mode
- Controller configured first, then 5-second wait for service initialization
- CAPs configured after controller is ready
- Deployment summary shows device roles

### New YAML Schema
```yaml
# Controller example
role: controller
capsman:
  certificate: auto
  requirePeerCertificate: false
ssids:
  - ssid: MyNetwork
    roaming:
      fastTransition: true  # 802.11r
      rrm: true             # 802.11k
      wnm: true             # 802.11v

# CAP example
role: cap
cap:
  controllerAddresses:
    - 10.212.254.1
  certificate: request
  lockToController: true
wifi:
  2.4GHz: { channel: 6 }   # Local override
```

### Backward Compatibility
- `role` defaults to `standalone` - existing configs work unchanged
- Migration is opt-in by adding `role` field

## [3.0.0] - 2026-01-15 - Per-SSID 802.11r Configuration

### Breaking Change
**Roaming configuration moved from device-level to per-SSID**

This allows disabling 802.11r (Fast Transition) for specific SSIDs where stationary devices (like Sonos speakers, IoT devices) may have compatibility issues.

#### Old Schema (v2.x)
```yaml
wifi:
  roaming:
    enabled: yes
    fastTransition: yes   # Applied to ALL SSIDs
ssids:
  - ssid: MyNetwork
    vlan: 100
    bands: [2.4GHz, 5GHz]
```

#### New Schema (v3.0)
```yaml
ssids:
  - ssid: MyNetwork
    vlan: 100
    bands: [2.4GHz, 5GHz]
    roaming:
      fastTransition: true   # Per-SSID control

  - ssid: Sonos
    vlan: 100
    bands: [2.4GHz]
    # No roaming = 802.11r disabled for this SSID
```

### Migration Guide
1. Remove `wifi.roaming` from your configuration
2. Add `roaming: { fastTransition: true }` to SSIDs that need 802.11r
3. Leave `roaming` absent for stationary device SSIDs

### Benefits
- **Fix Sonos/IoT issues**: Disable 802.11r for networks with stationary devices
- **Granular control**: Enable roaming only where mobile devices benefit
- **Cleaner config**: Roaming is now with the SSID it affects

### Technical Details
- Apply: Per-SSID `roaming.fastTransition` determines FT authentication type
- Backup: Detects FT per-interface and adds `roaming` to appropriate SSIDs
- wifi-qcom devices: Uses `security.ft=yes/no` parameter
- wifiwave2 devices: Uses `ft-psk,wpa2-psk` or `wpa2-psk` auth types

## [2.8.0] - 2026-01-12 - Graceful Client Handling During Updates

### Added - Staggered Multi-Device Deployment
- **Configurable delay between devices** - Default 5-second pause allows WiFi clients to roam to stable APs
- **`--delay <secs>`** - Set custom delay between devices (e.g., `--delay 10` for 10 seconds)
- **`--no-delay`** - Skip delays for faster deployment when client disruption is acceptable
- Delay only applies in sequential mode (not parallel)

### Added - WiFi Client Evacuation
- **Pre-reconfiguration client disconnect** - Clients are disconnected before interface cleanup begins
- **2-second roaming window** - Brief pause after disconnect gives clients time to find other APs
- Clients get a head start reconnecting elsewhere before interfaces are torn down
- Non-fatal: reconfiguration proceeds even if evacuation fails

### Improved - Client Experience During Fleet Updates
- Combined staggered deployment + client evacuation minimizes disruption
- Typical update flow: evacuate clients → reconfigure → wait → next device
- Clients on 802.11r/k/v networks benefit most from the roaming windows

### Usage
```bash
# Default: 5s delay between devices
./apply-multiple-devices.js multiple-devices.yaml

# Custom delay for slower client roaming
./apply-multiple-devices.js multiple-devices.yaml --delay 10

# Fast mode (no delays)
./apply-multiple-devices.js multiple-devices.yaml --no-delay
```

## [2.7.1] - 2026-01-10 - Critical VLAN Tagging Fix

### Fixed
- **VLAN tagging not applied** - WiFi clients were being placed on the untagged management VLAN instead of their configured VLAN. Root cause: referencing named datapath objects (`datapath="wifi1-vlan100"`) wasn't applying VLAN settings to interfaces. Fix: set `datapath.vlan-id` directly inline on each WiFi interface.
- **Interface name reset** - Added step to reset WiFi interface names to defaults during cleanup, ensuring idempotency when interfaces have been manually renamed.

## [2.7.0] - 2026-01-10 - Managed WAP Mode, LACP Bonding & Device Identity

### Added - Managed WAP Mode
- **Pure Layer 2 WAP operation** - Device now configured as a proper managed WAP
- **DHCP client on bridge** - Gets management IP from upstream network automatically
- **Router functions disabled** - Removes DHCP servers, static IPs, NAT rules, and DNS serving
- Ensures device operates purely as a VLAN-aware wireless access point

### Added - LACP Bonding Support
- **Bond management interfaces** - Combine multiple interfaces into LACP bonds (802.3ad)
- **High availability** - Redundant management connectivity for critical infrastructure
- **New YAML syntax** - Define bonds in `managementInterfaces` configuration
- **Backup support** - Bond configurations detected and exported during backup
- Uses layer-2-and-3 transmit hash policy with 30-second LACP rate

```yaml
managementInterfaces:
  - bond:
      - ether1
      - ether2
```

### Added - Automatic Device Identity
- **FQDN-based identity** - Automatically extract and set device identity from hostname
- Example: `indoor-wap-south.nickborgers.net` sets identity to `indoor-wap-south`
- **Override support** - Identity can be explicitly set in config.yaml
- **Smart backup** - Only stores identity if it differs from expected hostname

### Added - Deployment-Level Country Configuration
- **Centralized country setting** - Specify WiFi regulatory country at deployment level
- Applies to all devices in `multiple-devices.yaml`
- Maintains backward compatibility with per-band country settings
- Backup promotes country to deployment level when consistent across devices

### Fixed - WiFi-QCOM Package Support (cAP ax)
- **Package detection** - Correctly identifies wifi-qcom vs wifiwave2 by checking installed package name
- **Fast Transition auth** - wifi-qcom uses `security.ft=yes` instead of `ft-psk` auth type
- **Virtual interface timing** - Added delay after creating virtual interfaces
- **Special character escaping** - Fixed passphrase handling for #, !, ^, %, etc.
- **Direct interface naming** - Use direct names instead of `[find name=...]` for reliability

### Fixed - Radio Band Detection
- **Board-based detection** - Uses board name to detect devices with swapped radio layout
- **Per-model handling** - Correctly identifies which physical radio is 2.4GHz vs 5GHz
- **Channel band setting** - Explicitly sets channel.band during WiFi optimization

### Fixed - Configuration Reliability
- **Old SSID persistence** - Master interfaces now disabled when no SSIDs configured for band
- **Fresh device support** - Improved configuration for newly reset devices
- **SSH connection tracking** - Fixed state tracking for newer ssh2 versions
- **802.11r Fast Transition** - Fixed authentication for seamless roaming
- **Country code format** - Uses 'United States' not 'united_states'
- **Country regex** - Captures country values containing spaces
- **WiFi interface names** - Reset to defaults for idempotency

### Improved
- **Error messages** - Better feedback for authentication and connection failures
- **Code simplification** - Streamlined WiFi configuration code

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
