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