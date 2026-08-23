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
- `lib/access-list.js` - WAP locking via access-list rules
- `lib/router.js` - Router role: multi-WAN failover, NAT, DHCP server, DNS, firewall
- `lib/validate-router.js` - Shared router validation (used by BOTH apply entry points)
- `test/router.test.js` - Router regression tests (`npm test`)
- `router.example.yaml` - Example router configuration (multi-WAN failover)
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
- Script also sets bridge `admin-mac` to match (critical for DHCP static leases)
- The DHCP client runs on the bridge, so bridge MAC must match the static lease binding
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

**IGMP Snooping (Added v4.7.0)**
- Optional per-device boolean setting to enable IGMP snooping on the bridge
- IGMP snooping optimizes multicast traffic (Sonos, Chromecast, etc.)
- When enabled, multicast is only forwarded to ports with interested receivers
- Reduces unnecessary network load from multicast flooding
- Default: false (disabled) - matches MikroTik's default behavior
- Configuration: `igmpSnooping: true` at device level
- Applied during bridge infrastructure setup
- Backed up from device and stored only when enabled (omitted when false)

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

**CAPsMAN VLAN (Added v4.1.0, Updated v4.5.0)**
- Dedicated L2 VLAN for CAP↔Controller traffic (solves wifi-qcom L3 issues)
- Problem: wifi-qcom CAPsMAN has issues with L3/IP layer connections
- Solution: Put all CAP↔Controller traffic on a dedicated L2 VLAN
- Static IP addresses on each device (no DHCP needed, predictable addressing)
- Firewall rules block admin access via CAPsMAN VLAN (security)
- Only CAPWAP traffic (UDP 5246-5247) allowed on this VLAN
- Unified config structure (v4.5.0): All CAPsMAN settings in `capsman` block
  ```yaml
  # Deployment level (multi-device)
  capsmanVlan:
    vlan: 2525              # VLAN ID for CAPsMAN traffic
    network: 10.252.50.0/24 # Network for static IP addressing

  devices:
    # Controller
    - device: { host: controller.example.com, ... }
      role: controller
      capsman:
        certificate: auto
        vlan:
          address: 10.252.50.1  # Static IP on CAPsMAN VLAN
    # CAP device
    - device: { host: cap1.example.com, ... }
      role: cap
      capsman:
        controllerAddresses:
          - 10.252.50.1           # Controller's CAPsMAN VLAN IP
        vlan:
          address: 10.252.50.2    # Static IP on CAPsMAN VLAN
  ```
- Creates VLAN interface `capsman-vlan` on bridge
- CAPs use `capsman-vlan` as discovery interface when configured
- Legacy format (`cap.controllerAddresses`, `capsmanAddress`) still supported
- Rollback: `/interface vlan remove [find name=capsman-vlan]`

**wifi-qcom CAPsMAN (Added v4.3.0, Updated v5.0.0)**
- **v5.0.0: wifi-qcom is the only supported WiFi package** (wifiwave2 support removed)
- wifi-qcom doesn't support `/interface/wifi/capsman/configuration` or `/provisioning` commands
- Solution: Configure CAP-operated interfaces directly on the controller after CAPs connect
- CAP interfaces appear on controller with naming pattern: `<cap-identity>-2g`, `<cap-identity>-5g`
- Deployment phases:
  1. Phase 1: Enable CAPsMAN service on controller (no configuration objects)
  2. Phase 2: CAPs connect to controller, creating CAP interfaces
  3. Phase 2.5: Configure each CAP interface directly with SSID/security/datapath, **then configure controller local radios** (wifi1/wifi2) with correct per-SSID settings (FT, steering, datapath/VLAN)
- Detection: `detectWifiPackage()` returns `wifi-qcom` or null (wifiwave2 is rejected)
- Example CAP interface configuration:
  ```
  /interface/wifi set shed-wap-2g \
      configuration.ssid="MySSID" \
      security.authentication-types=wpa2-psk \
      security.passphrase="password" \
      datapath.bridge=bridge datapath.vlan-id=100 \
      channel.frequency=2412 \
      disabled=no
  ```

**CAPsMAN Channel Propagation (Fixed v5.3.0)**
- Problem: Channel settings from CAP device config were not applied to CAPsMAN-provisioned interfaces
- CAPsMAN would auto-select channels, ignoring the configured channel plan
- Root cause: Phase 2.5 configured SSID/security/datapath but not `channel.frequency`
- Solution: Apply channel settings as FINAL step, after all interface configuration is complete
- Channel settings must be applied last because CAPsMAN operations during virtual interface creation can reset channel.frequency
- Phase 2.5 now has a dedicated "Applying Channel Settings" phase at the end
- See: https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/10

**wifi-qcom Virtual SSID Traffic Fix (Added v4.9.0)**
- Problem: Clients on virtual SSIDs (PartlySonos, PartlyIoT, etc.) could associate but had no network connectivity
- Root cause: wifi-qcom CAPsMAN "traffic processing on CAP" mode has two requirements not documented by MikroTik:
  1. `slaves-static=yes` must be enabled in CAP settings
  2. Virtual WiFi interfaces must be added as bridge ports with correct PVID
- Without `slaves-static=yes`, local virtual interfaces remain "Inactive" and data traffic doesn't flow
- Without bridge ports, even with `datapath.bridge=bridge`, traffic isn't properly bridged
- Solution implemented:
  1. `configureCap()` now sets `slaves-static=yes` automatically
  2. `configureLocalCapFallback()` now adds virtual interfaces as bridge ports with PVID matching VLAN
  3. `configureLocalCapFallback()` restarts CAP mode after configuring interfaces to force CAPsMAN rebind
- CAP mode restart is necessary because CAPsMAN must rebind to newly created local interfaces
- Verification commands:
  ```
  /interface/wifi print                                    # Virtual interfaces should show "BR" (Bound, Running)
  /interface print stats where name~"ssid"                 # Should show non-zero RX/TX bytes
  /interface/bridge/host print where on-interface~"ssid"   # Should show client MACs
  ```
- References:
  - https://forum.mikrotik.com/t/wifi-capsman-wifi-qcom-ac-caps-and-slave-interfaces-in-vlan-environnent/181308
  - https://www.jaburjak.cz/posts/mikrotik-wifi-qcom-ac-vlans/

**Per-WAP SSID Customization (Added v5.1.0)**
- Enable each access point to broadcast different SSIDs on different bands
- Possible because wifi-qcom CAPsMAN configures CAP interfaces directly on controller
- Schema: Deployment-level SSIDs define PSK/VLAN/roaming, devices specify which SSIDs to broadcast
- Configuration structure:
  ```yaml
  # Deployment level - define SSIDs once
  ssids:
    - ssid: PartlyPrimary
      passphrase: secret
      vlan: 100
    - ssid: PartlyIoT
      passphrase: iot-secret
      vlan: 200

  devices:
    # Each device specifies which SSIDs and bands
    - device: { host: indoor-wap.example.com, ... }
      role: cap
      ssids:
        - ssid: PartlyPrimary
          bands: [2.4GHz, 5GHz]
        - ssid: PartlyIoT
          bands: [2.4GHz]

    - device: { host: outdoor-wap.example.com, ... }
      role: cap
      ssids:
        - ssid: PartlyPrimary
          bands: [2.4GHz]  # 2.4GHz only for range
        # No PartlyIoT on this AP
  ```
- Implementation:
  - `resolveSsidsForDevice()` merges device SSID refs with deployment templates
  - Phase 2.5: Passes per-CAP resolved SSIDs to controller
  - Phase 2.6: Uses per-CAP resolved SSIDs for local fallback
  - Backup: Auto-promotes SSIDs to deployment level for CAPsMAN deployments
- Use cases: Indoor/outdoor differentiation, guest network isolation, IoT placement

**CAPsMAN Radio Detection & Interface Renaming (Added v4.3.1)**
- MikroTik names CAP interfaces based on physical interface number, NOT actual radio band
- Problem: Many devices have swapped radios (wifi1=5GHz, wifi2=2.4GHz), including:
  - cAP ax, cAP ac (always swapped)
  - Some wAP ax units (varies by individual device!)
- IMPORTANT: Even identical board models can have different radio layouts
- Solution: Detect actual bands and **rename interfaces** so `-2g` is ALWAYS 2.4GHz, `-5g` is ALWAYS 5GHz
- Detection: `/interface/wifi/radio print detail` shows `bands=2ghz-*` or `bands=5ghz-*`
- Renaming process (swap names to avoid conflicts):
  ```
  managed-wap-north-2g → managed-wap-north-swap-temp (temp)
  managed-wap-north-5g → managed-wap-north-2g
  managed-wap-north-swap-temp → managed-wap-north-5g
  ```
- After renaming, interface names correctly reflect actual radio bands
- Virtual interfaces (SSIDs) inherit correct naming from master interfaces

**WAP Locking (Added v4.4.0)**
- Lock specific WiFi clients to specific access points using access-list rules
- Useful for stationary devices (Sonos, IoT) that roam unnecessarily
- Problem: Devices may roam to distant APs with weak signal, causing audio dropouts
- Solution: Create access-list rules that ACCEPT on target AP and REJECT on all others
- Rules are stored on the CAPsMAN controller and applied per-interface
- Configuration in `multiple-devices.yaml`:
  ```yaml
  devices:
    - device: { host: shed-wap.example.com, ... }
      role: cap
      lockedDevices:
        - hostname: sonos-barn        # Human-readable name (used in comment)
          mac: "80:4A:F2:8B:D2:FA"    # Client MAC address
          ssid: IoT-Devices           # Optional: specific SSID only
        - hostname: smart-thermostat  # No ssid = lock on ALL SSIDs
          mac: "48:A6:B8:8E:49:2C"
  ```
- Deployment: Phase 2.75 in `apply-multiple-devices.js` (after CAP interface config)
- Backup: `backup-multiple-devices.js` reads rules from controller, distributes to target devices
- Idempotent: removes existing rules for MAC before creating new ones
- Commands generated:
  ```
  /interface/wifi/access-list add mac-address="..." interface=<target-ap-interface> action=accept comment="hostname - lock to ap"
  /interface/wifi/access-list add mac-address="..." interface=<other-ap-interface> action=reject comment="hostname - reject (locked to ap)"
  ```
- Debug: `/interface/wifi/access-list print detail` on controller

**Router Role: Multi-WAN Failover (Added v6.1.0)**
- Fourth role alongside `standalone`, `controller`, `cap`. The device is the gateway, not an AP.
- The AP roles strip router functions on purpose (`lib/configure.js` removes DHCP servers, NAT, static bridge IPs, DNS). The router role keeps them. Never mix the two on one device.
- Implemented in `lib/router.js`; dispatched from `lib/configure.js`.
- Verified on the Chateau LTE6 (`D53G-5HacD2HnD&EG06-A`, RouterOS 7.18.2, 5 ether ports + lte1).
- Config shape:
  ```yaml
  role: router
  lan:
    address: 192.168.80.1/24
    ports: [ether2, ether3, ether4, ether5]
    dhcpServer: {pool: 192.168.80.100-192.168.80.200, leaseTime: 12h}
    dns: {servers: [1.1.1.1, 8.8.8.8], allowRemoteRequests: true}
  wan:
    - {name: primary, interface: ether1, type: dhcp, distance: 1, probe: 8.8.8.8}
    - {name: backup, interface: lte1, type: lte, apn: fast.t-mobile.com, distance: 2, probe: 1.1.1.1}
  ```
- WAN types: `dhcp`, `static`, `pppoe`, `lte`.

**Recursive-Route Failover (Why, Not Just What)**
- Each uplink gets a probe route (`dst-address=<probe>/32 gateway=<gw> scope=10`) plus a default route whose gateway IS the probe address (`gateway=<probe> target-scope=11 distance=<n> check-gateway=ping`).
- RouterOS resolves the default route recursively through the probe route.
- This detects a dead ISP behind a live modem. A modem that lost its uplink still answers ARP/ping on its LAN side, so plain `check-gateway=ping` on the next hop never notices.
- TWO detection paths, very different speeds. Measured on the Chateau LTE6 (wired <-> LTE):
  - Link DOWN (cable pulled / port disabled): the probe route's next hop stops resolving, so the default route deactivates immediately. **1.2s**. No ping timeout involved.
  - Link UP but path beyond it dead (ISP down behind live modem): must wait for probe pings to fail. **20-30s** (every 10s, 2 consecutive failures). This is the case the recursive design exists for.
  - Failback after the link returns: **~36s**, dominated by DHCP re-binding before the probe route can resolve.
- Do not quote a single number. Say which failure mode.
- STALE GATEWAY LIMIT: the probe route pins the gateway learned at apply time. If a dhcp/pppoe uplink returns with a DIFFERENT gateway, the pinned route is stale and that uplink will not recover until a re-apply. Apply is idempotent, so a scheduled re-apply covers it.
- Failover is fast, NOT seamless. Each uplink has its own public IP, so open connections break. Only an overlay tunnel would keep them.
- Every uplink is created with `add-default-route=no` so nothing competes with these routes.
- Every uplink gets `use-peer-dns=no` and the router uses `lan.dns.servers`. Keeping ISP resolvers means that after failover, routing works but every lookup times out - which reads as a failed failover and is very hard to diagnose.
- Each uplink needs its OWN probe address. Two uplinks sharing one probe fight over the same probe route. Validation rejects this.

**Router Role: Interface Lists and Comment Conventions**
- Maintains the `WAN` and `LAN` interface lists that RouterOS defconf already uses. One NAT rule (`out-interface-list=WAN`) and one firewall rule cover every uplink.
- The `WAN` list member comment is the AUTHORITATIVE record: `wan:<name> type=... distance=... probe=... [apn=...]`.
- Why: routes only exist while a link is up. Reading settings back from routes alone drops an unplugged uplink from the backup. The list member is always present.
- Other comments: routes `wan:<name> probe` / `wan:<name> default`, NAT `router:masquerade`, filter `router:<purpose>`, DHCP/pool/address `router:lan`.
- Backup detects the role via the `router:masquerade` NAT rule, not via routes, for the same reason.
- RouterOS `print detail` renders comments as `;;; <comment>` lines, NOT as `comment="..."`. Parse with `recordComment()` in `lib/router.js`. Getting this wrong silently returns nothing.
- `/ip dns print` wraps a multi-server list onto unlabelled continuation lines. Collect lines until the next `label:`.

**Router Role: Lockout Safety**
- Changing `lan.address` cuts the SSH session doing the work. This repo already has a lockout history (VLAN filtering, 3 times).
- `addLanAddress()` runs before the DHCP server (which needs the address to exist). `removeStaleLanAddresses()` runs last and REFUSES to remove the address whose subnet contains `config.host`.
- Result: run 1 over the old address leaves both addresses live. Run 2 over the new address removes the old one. Never a moment with no reachable address.
- Firewall order is deliberate: accept established, drop invalid, accept ICMP, accept `in-interface-list=LAN`, and only THEN drop `in-interface-list=!LAN`. The drop rule is skipped entirely if the LAN list cannot be verified to contain `bridge`.
- Fasttrack is OFF by default (`lan.fasttrack: true` to enable). Fasttracked flows skip connection tracking, which slows how fast stale sessions clear after a failover.

**LTE Notes (Chateau LTE6 / EG06-A)**
- `/interface lte monitor lte1 once` showing `status: connected` only means the modem attached to the tower. It does NOT mean the data session has an IP.
- If there is no address on lte1 and no default route, the APN is wrong. Check `/ip address print where interface=lte1`.
- Verified working APN on a Google Fi SIM: `fast.t-mobile.com`. `h2g2` did NOT work, despite being the commonly cited Google Fi APN.
- The role creates a per-uplink APN profile named `apn-<wan-name>` rather than editing the shared `default` profile.
- Omit `apn` in config to set `use-network-apn=yes` and let the network supply it.

**WiFi Package: wifi-qcom Only (and the Chateau migration)**
- `detectWifiPackage()` returns `wifi-qcom` or null. All WiFi code uses `/interface/wifi`.
- The Chateau LTE6 SHIPS the legacy `wireless` package (wlan1/wlan2, `/interface wireless`). That is not supported.
- The test device was migrated to `wifi-qcom-ac` (IPQ4019 supports it). Procedure, in this order:
  1. Free space first. Only ~1.1MB was free; the npk is 2.7MB. `/system package uninstall wireless` then reboot frees ~1.9MB.
  2. Upload `wifi-qcom-ac-<ver>-arm.npk` via SFTP (ssh2 `sftp.fastPut`; MikroTik supports the SFTP subsystem).
  3. Reboot again to install.
- Get the npk from `https://download.mikrotik.com/routeros/<ver>/all_packages-arm-<ver>.zip`. The download truncates often - resume with `curl -C -` in a retry loop and check the final byte count.
- `wifi-qcom-ac` contains the substring `wifi-qcom`, so `detectWifiPackage()` accepts it unchanged.
- Router config survived both reboots intact. Take `/export file=...` first anyway.

**WiFi Band Tokens Must Be Detected, Not Assumed**
- `channel.band=2ghz-ax` / `5ghz-ax` was hardcoded. It FAILS on any radio older than 802.11ax.
- `detectBandToken()` in `lib/wifi-config.js` reads `/interface/wifi/radio print detail` and picks the best supported token. Preference: `2ghz-ax > n > g > b`, `5ghz-ax > ac > n > a`. Falls back to `-ax`.
- IPQ4019 advertises `2ghz-g,2ghz-n` and `5ghz-a,5ghz-n,5ghz-ac` -> resolves to `2ghz-n` and `5ghz-ac`.

**RouterOS print detail Parsing Traps (all cost real debugging time)**
- Comments render as `;;; <comment>` lines, NOT `comment="..."`. Terse output differs from detail output.
- `country` prints UNQUOTED despite containing a space: `.country=United States`. A quoted-only regex silently returns nothing. Use `parseCountry()` in `lib/backup.js`.
- Multi-value fields wrap onto unlabelled continuation lines (`/ip dns print` servers, radio `bands=`).
- Record splitting must require the index at the left margin (`\n(?=\s{0,3}\d+\s)`). A looser `\s*` also matches the last line of a wrapped numeric list such as `2g-channels=...,\n      2472`, cutting records in half.
- Prefer scanning a whole record for a pattern over parsing exact field boundaries when the field can wrap.

**Untagged SSIDs (router role)**
- `configureWifiInterface()` omits `datapath.vlan-id` when `vlan` is undefined. No datapath object is created either.
- `lib/backup.js` no longer requires a datapath to record an SSID, and omits `vlan` for untagged ones.
- Validation: `vlan` is optional only when `role: router`.

**Router Role: Hard-Won Constraints (v6.1.1 review fixes)**
- Validation lives in `lib/validate-router.js`, NOT in `apply-config.js`. Both entry points must call it. It was previously only wired into the single-device path, so fleet routers were applied with zero validation.
- `removeStaleLanAddresses()` must resolve `config.host` to an IP before comparing. `config.host` is routinely an FQDN here; `ipToInt()` returns null for one, so the lockout guard silently never fires. If resolution fails, remove NOTHING.
- Each uplink's probe address must differ from every `lan.dns.servers` entry. The probe is pinned by a /32 with no health check, so a resolver pinned to a failing uplink stalls queries exactly when the network is degraded. Validation rejects the overlap.
- Never let two uplinks share a probe. Two /32 routes on one destination with different gateways make the recursive lookup follow whichever won. `DEFAULT_PROBES` has four entries; beyond that `normalizeWans()` throws rather than reusing one.
- Clear `WAN` list members by comment (`[find list=WAN comment~"^wan:"]`), not by the interfaces in the current config. Member comments are authoritative for backup, so a stale member resurrects a deleted uplink.
- No interface ever gets a NAMED datapath. `configureWifiInterface()` writes `datapath.bridge=... datapath.vlan-id=N` inline. Read the VLAN off the interface with `/(?:datapath)?\.vlan-id=(\d+)/` - a named-datapath lookup always returns nothing.
- `backup.js` deletes `managementInterfaces`/`disabledInterfaces` for routers. Any consumer must guard for that; `backup-multiple-devices.js` crashed on it.
- Run `npm test` (`test/router.test.js`) before touching parsing or validation. Its fixtures are real captured RouterOS output.

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

## SSH Access to Devices

**DO NOT use the `ssh` command directly** - it will fail with password authentication.

**Use the MikroTikSSH class from the script:**
```javascript
node -e "
const {MikroTikSSH} = require('./mikrotik-no-vlan-filtering.js');
async function run() {
  const mt = new MikroTikSSH('managed-wap-south.nickborgers.net', 'admin', 'admin');
  await mt.connect();
  const result = await mt.exec('/interface/wifi/registration-table print');
  console.log(result);
  await mt.close();
}
run().catch(e => console.error(e.message));
"
```

**Common commands to run:**
- `/interface/wifi print` - List WiFi interfaces
- `/interface/wifi/registration-table print` - Show connected clients
- `/interface/wifi/capsman print` - CAPsMAN status
- `/interface/wifi/capsman/remote-cap print` - Connected CAPs
- `/interface/wifi/access-list print detail` - Show WAP locking rules
- `/system/resource print` - System info

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