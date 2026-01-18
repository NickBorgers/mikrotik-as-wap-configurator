# Network Configuration as Code - MikroTik

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-mikrotik--as--wap--configurator-blue?logo=docker)](https://github.com/NickBorgers/mikrotik-as-wap-configurator/pkgs/container/mikrotik-as-wap-configurator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

YAML-based configuration management for MikroTik network devices with safe, repeatable deployments.

## Network Topology

```mermaid
graph TB
    subgraph "MikroTik WAP"
        Bridge[Bridge Interface]

        subgraph "Trunk Port"
            Ether1[ether1<br/>Trunk to Upstream Switch<br/>Untagged: Management<br/>Tagged: VLANs 100, 200]
        end

        subgraph "WiFi SSIDs"
            subgraph "VLAN 100 - MyNetwork"
                SSID1_24[MyNetwork 2.4GHz<br/>VLAN 100]
                SSID1_5[MyNetwork 5GHz<br/>VLAN 100]
                SSID2_5[MyNetwork-5G<br/>VLAN 100]
            end

            subgraph "VLAN 200 - Guest"
                SSID3_24[Guest-WiFi 2.4GHz<br/>VLAN 200]
                SSID3_5[Guest-WiFi 5GHz<br/>VLAN 200]
            end
        end

        Ether1 <-->|Bridged| Bridge
        SSID1_24 -->|Tagged 100| Bridge
        SSID1_5 -->|Tagged 100| Bridge
        SSID2_5 -->|Tagged 100| Bridge
        SSID3_24 -->|Tagged 200| Bridge
        SSID3_5 -->|Tagged 200| Bridge
    end

    Ether1 --> Switch[Upstream Switch<br/>Handles VLAN Routing]
    Switch --> MgmtNet[Management VLAN<br/>Untagged on ether1]
    Switch --> VLAN100Net[VLAN 100 Network<br/>Private Devices]
    Switch --> VLAN200Net[VLAN 200 Network<br/>Guest Network]

    style Bridge fill:#4a90e2,stroke:#333,stroke-width:3px,color:#fff
    style Switch fill:#e74c3c,stroke:#333,stroke-width:3px,color:#fff
    style MgmtNet fill:#ff9500,stroke:#333,stroke-width:2px,color:#fff
    style VLAN100Net fill:#50c878,stroke:#333,stroke-width:2px,color:#fff
    style VLAN200Net fill:#9b59b6,stroke:#333,stroke-width:2px,color:#fff
```

## Quick Start

> **New to this?** See [GETTING-STARTED.md](GETTING-STARTED.md) for detailed first-time setup instructions.

### Docker (Recommended)

```bash
# Get example configuration
docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator example > config.yaml

# Edit config.yaml with your settings, then apply
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator apply
```

See [DOCKER.md](DOCKER.md) for complete Docker documentation.

### Node.js Installation

**Prerequisites:**
- Node.js (LTS version)
- SSH access to MikroTik device via Ethernet
- MikroTik RouterOS v7+ (with WiFi package)

⚠️ **Important**: Management must be performed over Ethernet (ether1). Do not manage the device via WiFi as the script reconfigures all WiFi interfaces.

```bash
npm install
```

### Backup Existing Configuration

If you have an already-configured MikroTik device, you can export its current configuration:

```bash
./backup-config.js 192.168.88.1 admin your-password config.yaml
```

This will connect to the device and generate a `config.yaml` file from the current configuration, including:
- WiFi SSIDs, VLANs, and bands
- Bridge port assignments
- Disabled interfaces

⚠️ **Important:** Some passphrases may be marked as `UNKNOWN` if MikroTik does not expose them via SSH (depends on RouterOS version and security settings). You must manually edit the file and replace any `UNKNOWN` passphrases with actual values before applying the configuration.

### Configure a Device (Fresh or Existing)

1. Create your configuration file:

```bash
cp config.example.yaml my-device.yaml
```

Or backup an existing device:

```bash
./backup-config.js 192.168.88.1 admin password my-device.yaml
```

2. Edit the configuration:

```yaml
device:
  host: 192.168.88.1
  username: admin
  password: your-password

managementInterfaces:
  - ether1

disabledInterfaces:
  - ether2

ssids:
  # SSID on both bands (most common)
  - ssid: MyNetwork
    passphrase: your-wifi-password
    vlan: 100
    bands:
      - 2.4GHz
      - 5GHz

  # Guest network on different VLAN
  - ssid: Guest-WiFi
    passphrase: guest-password
    vlan: 200
    bands:
      - 2.4GHz
      - 5GHz
```

3. Apply the configuration:

```bash
./apply-config.js my-device.yaml
```

**This same command works for:**
- ✅ Fresh out-of-box devices
- ✅ Updating existing configurations
- ✅ Adding/changing SSIDs
- ✅ Changing passwords

The script is **idempotent** and safe to run multiple times.

## Features

### Core Features
- **YAML-based configuration** - Human-readable, version-controllable device configs
- **Idempotent operations** - Safe to run multiple times; device state matches config
- **Multi-SSID support** - Multiple SSIDs per band using virtual WiFi interfaces
- **VLAN tagging** - WiFi client isolation via datapaths (no bridge VLAN filtering)
- **Backup & restore** - Export running config to YAML, apply to new devices

### Advanced WiFi
- **Channel optimization** - Automatic non-overlapping channel suggestions for multi-AP
- **TX power control** - Per-band transmit power configuration
- **Channel width** - 20MHz, 40MHz, 80MHz, 160MHz support

### Fast Roaming (802.11r/k/v)
- **802.11r** - Fast BSS Transition for seamless handoffs between APs
- **802.11k** - Neighbor reports (APs tell clients about nearby APs)
- **802.11v** - BSS Transition Management (client steering)
- **Per-SSID control** - Enable roaming for mobile devices, disable for IoT/Sonos

### CAPsMAN Centralized Management
- **Controller mode** - Centralized WiFi management with coordinated roaming
- **CAP mode** - Controlled Access Points receiving config from controller
- **Dedicated VLAN** - Optional L2 VLAN for CAP↔Controller traffic
- **Local WiFi fallback** - CAPs continue working if controller goes offline
- See `multiple-devices.example.yaml` for CAPsMAN configuration examples

### Enterprise Features
- **LACP bonding** - Redundant management uplinks (802.3ad)
- **WAP locking** - Lock specific clients to specific APs via access-list rules
- **Remote syslog** - Centralized logging of WiFi events
- **Automatic identity** - Device identity extracted from FQDN hostname

## Multi-Device Management

Configure multiple devices at once using a single YAML file.

### Quick Start - Multi-Device

```bash
# 1. Create file with device credentials
cat > multiple-devices.yaml <<EOF
devices:
  - host: 192.168.88.1
    username: admin
    password: password
  - host: 192.168.88.2
    username: admin
    password: password
EOF

# 2. Backup all devices (updates file in-place with full configs)
./backup-multiple-devices.js multiple-devices.yaml

# 3. Review and edit configs if needed (check for UNKNOWN passphrases)
nano multiple-devices.yaml

# 4. Apply to all devices
./apply-multiple-devices.js multiple-devices.yaml

# Or apply in parallel (faster)
./apply-multiple-devices.js multiple-devices.yaml --parallel
```

The backup tool enriches your simple device list with full configurations from the devices.

### 3. Multi-Device Configuration Format

```yaml
devices:
  - device:
      host: 192.168.88.1
      username: admin
      password: password
    managementInterfaces:
      - ether1
    disabledInterfaces:
      - ether2
    ssids:
      - ssid: MyNetwork
        passphrase: password123
        vlan: 100
        bands: [2.4GHz, 5GHz]

  - device:
      host: 192.168.88.2
      username: admin
      password: password
    managementInterfaces:
      - ether1
    disabledInterfaces:
      - ether2
    ssids:
      - ssid: MyNetwork
        passphrase: password123
        vlan: 100
        bands: [2.4GHz, 5GHz]
```

Each device can have its own unique configuration or share common settings.

## Configuration File Format

```yaml
# Device connection
device:
  host: <ip-address>
  username: admin
  password: <password>

# Management interfaces (untagged traffic)
managementInterfaces:
  - ether1
  - ether2

# SSIDs - Band-based configuration
ssids:
  - ssid: <broadcast-name>
    passphrase: <wpa2-password>
    vlan: <vlan-id>
    bands:
      - 2.4GHz    # Broadcast on 2.4GHz band (wifi1)
      - 5GHz      # Broadcast on 5GHz band (wifi2)
      # You can specify one or both bands
```

### Band Configuration

Each SSID can specify which bands it should broadcast on:

- **Both bands** (typical): `bands: [2.4GHz, 5GHz]` - Same SSID on both radios
- **2.4GHz only**: `bands: [2.4GHz]` - Better range, slower speed
- **5GHz only**: `bands: [5GHz]` - Shorter range, faster speed

The same SSID name can be used on both bands, providing seamless roaming for clients.

## How It Works

### Safe Configuration Approach

This system uses a **VLAN filtering disabled** approach to prevent lockouts while still achieving network isolation:

1. **WiFi VLAN Isolation**: Achieved through WiFi datapaths, not bridge VLAN filtering
2. **Management Access**: Always preserved on bridge interface
3. **No Lockout Risk**: VLAN filtering disabled = device always accessible
4. **Layer 2 Isolation**: WiFi clients isolated via datapath VLAN tagging

### MikroTik RouterOS v7 WiFi Configuration

In RouterOS v7, WiFi is configured directly on interfaces using inline properties:

```javascript
// Correct syntax for RouterOS v7
/interface/wifi set wifi1
  configuration.ssid=SSID-1
  security.authentication-types=wpa2-psk
  security.passphrase=password
  datapath.vlan-id=100
```

## Scripts

| Script | Purpose |
|--------|---------|
| `apply-config.js` | Apply YAML configuration to single device |
| `apply-multiple-devices.js` | Apply YAML configuration to multiple devices |
| `backup-config.js` | Export current device configuration to YAML |
| `backup-multiple-devices.js` | Export multiple device configurations to YAML |
| `configure-device.sh` | Automated configuration with password update |
| `diag/wait-for-device.js` | Wait for device to be ready |
| `diag/check-status.js` | View WiFi interfaces, datapaths, and bridge configuration |
| `diag/optimize-wifi-channels.js` | Analyze and suggest optimal WiFi channels |

## Usage Examples

### Single Device Operations

#### Backup Single Device

```bash
# Backup to default file (config-backup.yaml)
./backup-config.js 192.168.88.1 admin password

# Backup to specific file
./backup-config.js 192.168.88.1 admin password my-backup.yaml
```

#### Configure Single Device

```bash
./apply-config.js config.yaml
```

#### Configure Different IP

```bash
./apply-config.js config.yaml 192.168.1.100
```

### Multi-Device Operations

#### Backup Multiple Devices

```bash
# Update file in-place with full configurations (default)
./backup-multiple-devices.js multiple-devices.yaml

# Save to different file
./backup-multiple-devices.js multiple-devices.yaml --output backup.yaml
```

#### Configure Multiple Devices

```bash
# Sequential (default, clearer output)
./apply-multiple-devices.js multiple-devices.yaml

# Parallel (faster)
./apply-multiple-devices.js multiple-devices.yaml --parallel
```

### Automated Configuration

```bash
./configure-device.sh <password> [config-file]
```

### Batch Configuration

```bash
for ip in 192.168.1.{10..20}; do
  ./apply-config.js config.yaml $ip
done
```

## Network Configuration

### Management VLAN (Untagged)
- **ether1**: Trunk port (untagged management + tagged VLANs 100, 200)
- **ether2**: Disabled by default (can be enabled via config)
- Provides administrative access to device
- Bridge IP remains accessible

### Client VLAN (VLAN 100)
- **WiFi SSIDs**: All configured on VLAN 100 via datapaths
- Client traffic isolated from management
- All SSIDs share same broadcast domain

### Bridge Configuration
- VLAN filtering: **DISABLED** (safe mode)
- Management access: Always available
- WiFi isolation: Via datapaths

## Troubleshooting

### Device Not Accessible

Check both management IP and bridge IP:
```bash
ssh admin@<management-ip>
ssh admin@192.168.88.1
```

### WiFi Not Broadcasting

Verify WiFi configuration:
```bash
ssh admin@<device-ip>
/interface/wifi print
```

Reconfigure if needed:
```bash
./apply-config.js config.yaml
```

### Reset to Defaults

Factory reset the device and reapply configuration:
```bash
./configure-device.sh <password> config.yaml
```

## Security Considerations

- **Management via Ethernet only**: This tool assumes device management is performed over Ethernet (ether1), not WiFi. WiFi configurations may be removed/reconfigured during script execution.
- Change default passwords before deployment
- Use strong WPA2 passphrases (12+ characters minimum)
- Keep configuration files secure (contain credentials)
- Consider environment variables for sensitive data
- Regularly update RouterOS firmware

## Advanced: VLAN Filtering

This configuration uses **VLAN filtering disabled** for safety. To enable full VLAN filtering with proper isolation:

1. Management VLAN interface must be created first
2. Management IP must be moved to VLAN interface
3. Bridge VLAN table must include management VLAN
4. Enable VLAN filtering as final step

⚠️ **Warning**: Improper VLAN filtering configuration will cause immediate lockout. Only attempt if you understand MikroTik VLAN filtering and have console access.

## Project Structure

```
network-config-as-code/
├── apply-config.js              # Single device configuration CLI
├── apply-multiple-devices.js    # Multi-device configuration CLI
├── backup-config.js             # Single device backup CLI
├── backup-multiple-devices.js   # Multi-device backup CLI
├── mikrotik-no-vlan-filtering.js # Facade re-exporting lib/ modules
├── lib/                         # Core library modules
│   ├── index.js                 # Public API exports
│   ├── configure.js             # Main configureMikroTik entry point
│   ├── capsman.js               # CAPsMAN controller/CAP functions
│   ├── backup.js                # Device backup functionality
│   ├── access-list.js           # WAP locking via access-list rules
│   ├── infrastructure.js        # Bridge, DHCP, bonding, syslog
│   ├── wifi-config.js           # Radio detection, interface config
│   ├── ssh-client.js            # MikroTikSSH class
│   ├── constants.js             # Band maps, frequency tables
│   └── utils.js                 # Path helpers, string escaping
├── diag/                        # Diagnostic tools
│   ├── check-status.js          # View WiFi/datapath/bridge config
│   ├── check-running.js         # Monitor runtime status and clients
│   ├── optimize-wifi-channels.js # Channel optimization for multi-AP
│   └── wait-for-device.js       # Wait for device after reboot
├── config.yaml                  # Single device config (gitignored)
├── config.example.yaml          # Example single device config
├── multiple-devices.yaml        # Multi-device config (gitignored)
├── multiple-devices.example.yaml # Example multi-device config
├── configure-device.sh          # Automated setup script
├── docker-entrypoint.sh         # Docker container entrypoint
├── Dockerfile                   # Multi-stage Docker build
├── README.md                    # This file
├── GETTING-STARTED.md           # First-time setup guide
├── DOCKER.md                    # Docker usage guide
├── CHANGELOG.md                 # Version history
└── LICENSE                      # MIT License
```

## License

MIT - See [LICENSE](LICENSE) file for details
