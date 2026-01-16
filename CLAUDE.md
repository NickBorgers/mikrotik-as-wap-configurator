# Claude Code Development Notes

## Development Workflow

- Create commits frequently to save progress
- After every commit, review the repo for no longer needed content and prune as cleanup
- Management is performed via Ethernet (ether1 only) - never WiFi
- Test device is accessible at 10.212.254.51 with credentials in config.yaml
- ether2 is disabled by default for security (unused interface)

## Project Architecture

### Core Files
- `mikrotik-no-vlan-filtering.js` - Main configuration library with SSH client wrapper
- `apply-config.js` - CLI tool that validates YAML and calls configureMikroTik()
- `backup-config.js` - CLI tool that exports current device config to YAML
- `apply-multiple-devices.js` - CLI tool for multi-device configuration
- `backup-multiple-devices.js` - CLI tool for multi-device backup
- `config.yaml` - Active device configuration (gitignored, contains credentials)
- `config.example.yaml` - Example for documentation and Docker image
- `multiple-devices.yaml` - Multi-device configuration file (gitignored, contains credentials)
- `multiple-devices.example.yaml` - Example multi-device configuration

### Key Design Decisions

**Automatic Device Identity**
- When connecting to devices via FQDN (e.g., indoor-wap-south.nickborgers.net), the hostname is automatically extracted and set as the device identity
- For indoor-wap-south.nickborgers.net, identity is set to "indoor-wap-south"
- Identity can be explicitly overridden in config.yaml with `identity: custom-name`
- When backing up, identity is only stored if it differs from the expected hostname
- Helps maintain consistent naming across fleet of devices

**VLAN Filtering: DISABLED**
- Bridge VLAN filtering is intentionally disabled to prevent lockouts
- We tried enabling it 3+ times during development - always resulted in lockout requiring physical reset
- WiFi VLAN isolation achieved via WiFi datapaths instead (safer approach)
- Trade-off: Less secure than full VLAN filtering, but sufficient for WiFi AP use case
- MikroTik acts as "dumb" VLAN-aware AP - tags traffic, upstream switch enforces policy

**Single Trunk Port (ether1)**
- ether1 serves dual purpose: management (untagged) + VLAN trunk (tagged 100, 200)
- ether2 disabled by default for security (can be re-enabled via config if needed)
- Upstream switch must handle both untagged management and tagged VLAN traffic on ether1

**LACP Bonding (for redundant uplinks)**
- LACP bonds (802.3ad) supported for devices with multiple Ethernet ports
- Script reads first interface's MAC and sets `forced-mac-address` on bond
- This ensures consistent MAC for DHCP static leases regardless of interface startup order
- Note: MikroTik's `primary` parameter only affects failover, not MAC address selection
- Requires upstream switch configured for LACP on corresponding ports
- Example config: `managementInterfaces: [{bond: [ether1, ether2]}]`

**Virtual WiFi Interfaces**
- MikroTik RouterOS v7 supports virtual WiFi interfaces on same radio
- Master interfaces: wifi1 (2.4GHz), wifi2 (5GHz)
- Virtual interfaces: wifi1-ssid2, wifi1-ssid3, wifi2-ssid2, etc.
- Script creates virtual interfaces automatically when multiple SSIDs target same band

**Configuration Cleanup (Added v2.1.0)**
- Script removes ALL virtual WiFi interfaces before applying config
- Script removes ALL WiFi datapaths (matching name~"wifi") before applying config
- Ensures device state matches config.yaml exactly
- Idempotent: can run multiple times safely

**Band-to-Interface Mapping**
```javascript
const BAND_TO_INTERFACE = {
  '2.4GHz': 'wifi1',
  '5GHz': 'wifi2'
};
```

**CAPsMAN Architecture (Added v4.0.0)**
- CAPsMAN provides centralized WiFi management with coordinated 802.11r/k/v roaming
- Three device roles: `standalone` (default), `controller`, `cap`
- Controller device runs CAPsMAN service and manages CAP devices
- Controller also acts as an AP (hybrid mode) - no separate controller hardware needed
- CAPs receive WiFi configuration from controller, apply local channel overrides
- Works over L3 (routed networks) - CAPs don't need to be on same VLAN as controller
- DTLS encryption secures CAP-to-controller management traffic
- Firewall: allow UDP 5246-5247 from CAP VLANs to controller
- Certificate authentication available for enhanced security

**CAPsMAN vs Standalone Roaming**
- Standalone with 802.11r: Client-dependent roaming, no AP coordination
- CAPsMAN with 802.11r/k/v: Coordinated roaming with shared PMK keys and client steering
- 802.11k (neighbor reports): APs tell clients about nearby APs
- 802.11v (BSS transition): APs can proactively steer weak-signal clients
- For full roaming benefits, use CAPsMAN mode

**CAPsMAN Deployment Order**
- Controller MUST be configured before CAPs
- `apply-multiple-devices.js` auto-detects CAPsMAN and deploys controller first
- 5-second wait after controller for CAPsMAN service to initialize
- CAPs then connect and receive configuration

### MikroTik RouterOS v7 WiFi Quirks

**Inline Configuration (not separate objects)**
- RouterOS v7 uses inline WiFi properties, not configuration objects
- Correct: `/interface/wifi set wifi1 configuration.ssid="SSID" datapath="datapath-name"`
- Wrong: Creating separate configuration objects and referencing them

**Datapath VLAN Tagging**
- Datapaths tag WiFi client traffic with VLANs
- Each SSID/VLAN combo needs its own datapath
- Naming: `wifi1-vlan100`, `wifi2-ssid2-vlan50`, etc.

### Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md` with changes
3. Commit with version message
4. Create git tag: `git tag -a vX.Y.Z -m "description"`
5. Push: `git push origin main && git push origin vX.Y.Z`
6. GitHub Actions automatically builds/publishes Docker image to `ghcr.io/nickborgers/mikrotik-as-wap-configurator`

### Docker Image

- Multi-stage build with Node.js Alpine
- Entrypoint: `docker-entrypoint.sh` handles help/example/apply
- Published to Docker Hub on git tag push
- Multi-arch: linux/amd64, linux/arm64
- Volume mount: `/config/config.yaml`

### Common Issues

**Device Lockout**
- If enabling VLAN filtering causes lockout, physical reset required
- Password after reset: see config.yaml (currently DQ45LVEQRZ)
- This is why we use VLAN filtering disabled approach

**Old SSIDs Persisting**
- Fixed in v2.1.0 with cleanup step
- Script now removes old virtual interfaces/datapaths before applying

**WiFi Not Broadcasting**
- Check that SSID is in config.yaml
- Verify correct band specified
- Run `./apply-config.js config.yaml` to reapply

## Testing

Backup existing configuration:
```bash
./backup-config.js 10.212.254.51 admin DQ45LVEQRZ config.yaml
```

Apply configuration:
```bash
./apply-config.js config.yaml
```

Multi-device backup (updates file in-place):
```bash
./backup-multiple-devices.js multiple-devices.yaml
```

Multi-device backup (save to different file):
```bash
./backup-multiple-devices.js multiple-devices.yaml --output backup.yaml
```

Multi-device apply:
```bash
./apply-multiple-devices.js multiple-devices.yaml
./apply-multiple-devices.js multiple-devices.yaml --parallel
```

Check device (requires ssh2 npm package):
```bash
node -e "const {MikroTikSSH} = require('./mikrotik-no-vlan-filtering.js'); ..."
```

Build Docker image locally:
```bash
docker build -t mikrotik-config-test .
docker run mikrotik-config-test help
```
- When asked to cut a release use gh to create a release object on GitHub
- When you add configurability always ensure it will be backed up correctly in addition to be something which can be applied