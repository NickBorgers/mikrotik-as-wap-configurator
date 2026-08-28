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
- `lib/routeros-args.js` - Command-argument encoding/validation (use for EVERY device command value)
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
  notify: {url: https://ntfy.sh/topic, title: office router failover, interval: 30s}  # optional
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

**Router Role: WAN Failover Notification (Added v6.2.0)**
- Optional `notify` block on a `role: router` config. Installs a `wan-notify` script plus a scheduler of the same name, both commented `router:wan-notify`. Absent block = both removed, so deleting the block turns it off.
- Shape: `notify: {url, title?, interval?, checkCertificate?}`. `url` is any http(s) POST target; `title` becomes an `X-Title:` header (ntfy renders it); `interval` defaults to `30s`; `checkCertificate` defaults to FALSE.
- Message body: `<identity> WAN: <prev uplink> -> <cur uplink>`, using the names from the `wan` block.
- Implemented in `lib/router.js` (`wanNotifyScript`, `configureWanNotify`, `backupWanNotify`, `parseDeviceMode`).

**`:global` DOES NOT PERSIST BETWEEN SCHEDULER RUNS (the trap this feature is built around)**
- A `:global` set by a script the SCHEDULER runs is discarded before the next tick. Verified: after clearing it and letting the scheduler tick repeatedly, the variable was absent from `/system/script/environment` entirely.
- The same script run by hand with `/system script run` DOES persist it. So the bug looks like it works in every interactive test. Do not "fix" the comment-based state back into a global.
- State is stored in the script object's own `comment`: `router:wan-notify state=<uplink>`. It is config, so it survives a reboot (a global does not), and it is written only on a real change, so there is no flash wear.
- Read it with `[/system script get $id comment]`. Confirmed the write is attributed to `scheduler:wan-notify`, so a scheduler-run script really can persist its own state this way.

**Device-mode Can Block This Entirely**
- On a Chateau LTE6 in `mode: home`, BOTH `fetch` and `scheduler` are disabled. `/system/scheduler/add` fails with "failure: not allowed by device-mode"; `/tool/fetch` fails the same way at runtime.
- Unlock: `/system/device-mode/update scheduler=yes fetch=yes`, then a PHYSICAL power cycle or reset-button press within 5 minutes. No tool can do that step.
- `configureWanNotify()` reads `/system/device-mode/print` FIRST and fails with that instruction rather than surfacing the low-level error. Everything else in the apply still lands; the problem is reported through `configureRouter()`'s postcondition list.
- `/tool/netwatch` is NOT device-mode gated, if a future feature needs a scheduler-free trigger.
- Parse the flags with `parseDeviceMode()`. A device that reports no device-mode at all returns null, which means "cannot tell", not "blocked".

**Notifier Implementation Details (all verified on hardware)**
- `check-certificate=no` is the default because a factory device has ZERO certificates (`/certificate/print count-only` = 0) and this one had ~292KiB of flash free, too little for a CA bundle.
- `output=none` on `/tool fetch`, for the same flash reason.
- Advance the stored state ONLY inside the `:do {...}` block, after the fetch. A failed send then retries on the next tick instead of being lost - which is exactly the failover that took the internet with it. Log both outcomes with `:log`.
- Detect the active uplink from the routes the role already writes: `[:len [/ip route find comment="wan:<name> default" active=yes]] > 0`. Emit one `:if` per uplink, WORST distance first, so the most preferred active uplink wins the last assignment. `cur` starts at `"none"` so a total outage is a state of its own.
- `/system/script/print detail` output CONTAINS THE SOURCE, so grepping the record for `state=` matches the code that writes the comment. Read the comment field: `:foreach s in=[/system script find comment~"^router:wan-notify"] do={:put [/system script get $s comment]}`.
- A script body cannot be sent with real newlines (they end the command). `scriptSource()` in `lib/routeros-args.js` escapes with `escapeMikroTik()` FIRST and rewrites newlines to `\n` second. `$` becomes `\$` on the wire and lands back as `$` in the stored source, so script variables survive.
- Re-apply preserves the stored state when it still names a configured uplink, so applying does not itself fire a notification. A fresh install deliberately sends `unknown -> <uplink>` on the first tick, which proves the whole path works.
- A `wan-notify` script or scheduler that is NOT commented `router:wan-notify` belongs to someone else. Report it and stop; do not add over it.
- A comma in `notify.title` would split the RouterOS `http-header-field` into a second header. Validation rejects it.
- A POST to an unreachable endpoint took ~10s to give up and blocks the tick, so an interval under 10s warns.

**Management Binding Requires Every Uplink To Have An Address**
- `configureManagementServices()` binds NOTHING - not even the LAN range - unless every
  uplink that must resolve holds an address. An unresolved DHCP/LTE/PPPoE uplink can take
  one inside `lanNetwork` or an allow entry moments later, which would make the binding
  admit the WAN.
- Consequence: a standby uplink that is unplugged, or an LTE backup with no signal, defers
  hardening indefinitely. That is intended. Do NOT add an override that skips unresolved
  uplinks - it re-opens exactly the hole this exists to close.
- TWO sets, deliberately: `mustResolve` (must have an address before any range is trusted)
  and `checkAddresses` (any address present must be checked for overlap). A PPPoE PARENT is
  in the second only: it normally has no address, so requiring one makes the feature
  permanently inert, but it CAN carry one (DHCP to reach the modem) and that address is on
  the WAN side. Conflating the two sets broke it in both directions during review.

**RouterOS Reports Errors On STDOUT With A NON-ZERO EXIT (fixed in 6.2.4)**
- A rejected command writes its error to **stdout**, leaves **stderr empty**, and exits
  **non-zero**. Before 6.2.4 `exec()` only rejected on stderr, so it resolved and returned
  the error text as data. Every `try/catch` around `mt.exec` was decorative.
- `exec()` now rejects on non-zero exit, on a signal, and on stderr. Verified on hardware.
- Detect failure by the EXIT CODE, never by matching the output. `/log print` legitimately
  contains "failure" and "error"; a string heuristic would reject real data. There is a
  test pinning this - do not replace it with pattern matching.
- Idempotent patterns are unaffected (verified): `remove`/`set`/`disable` on an empty
  `[find ...]` and `print`/`find` with no matches all exit 0. `get` on a missing item
  exits 1 and now throws, which is correct.
- Exit codes do NOT catch a command that is accepted but answers nothing (a bare
  `get` without `:put`). That is the separate 6.2.3 trap - see below.
- Handled errors are respected (verified): `:do {...} on-error={...}` catching a RUNTIME
  error exits 0. A SYNTAX error inside the block still exits 1, because it fails at parse
  time and on-error never runs. Compound `a; b` propagates a failure in either statement.
- Errors must NEVER contain the command text: WiFi commands carry
  `security.passphrase="..."` and callers log `e.message`. Device output is passed through
  `redactSecrets()` first. There is a test asserting a passphrase cannot reach an error.
- A MISSING exit status (ssh2 reports null/undefined when the channel closes without an
  exit-status request) is distinct from a non-zero one. It still rejects - unknown is not
  success - but with its own message, not a misleading "exit null".

**RouterOS `get` MUST Be Wrapped In `:put` (learned the hard way in 6.2.2)**
- `/interface get [find name=X] running` sent over an SSH exec prints NOTHING. RouterOS
  returns the value to an interactive console, not to stdout. Always:
  `:put [/interface/get [find name=X] running]`
- 6.2.2 shipped the bare form. Every read came back empty, so every interface looked
  not-running and every classification lookup looked empty. The apply reported a healthy
  master as dead and never ran the VAP retry it existed to run.
- Unit tests did NOT catch this: the fake answered whatever it was asked. A mock that
  answers a question the real device ignores passes every time. When adding a NEW device
  query, run it against real hardware, and assert the command FORM in a test.
- `test/router.test.js` scans lib/wifi-config.js for `exec()` calls sending a bare
  `get [find ...]`. Keep that guard.

**Writing WiFi Config Is Not The Same As The Radio Accepting It**
- A virtual AP created while its master is being reconfigured in the same pass can be
  rejected by the radio. RouterOS reports this ONLY as a comment on the interface
  (`;;; failed to create interface`) and the configuring `set` returns NO error.
- This bit us in production: `✓ Configured wifi2-ssid2` was logged while PartlyWork was
  silently off the air for a day, behind an otherwise green apply.
- `ensureWifiInterfaceUp()` in `lib/wifi-config.js` reads `/interface get [find name=X]
  running` after every SSID is written. `running` is the authoritative signal - do not
  parse the flag column out of `print detail` for this.
- Recovery is disable-then-enable of THAT VIRTUAL AP ONLY, up to 3 attempts.
- **NEVER bounce a master radio.** `configureWifiInterface()` is called with the MASTER
  for the primary SSID on every band, so this code path runs against masters routinely.
  A master carries every associated client, very possibly including the operator running
  this tool over that radio. A master also reads not-running for benign reasons (DFS
  availability check, CAP still provisioning, CAPsMAN not done activating), so it is
  DEFERRED and then POLLED until it comes up, never bounced. Do NOT just return
  "healthy" for a not-running master: a bad channel or driver fault reads identically to
  a DFS check, and calling it fine puts the original bug back on the primary SSID.
- The deferred check POLLS (default 90s budget, 5s interval); it is not a fixed sleep.
  DFS CAC takes ~60s and `configureCapInterfacesOnController()` applies channel settings
  immediately before the recheck, which can RESTART CAC. A short fixed wait reports every
  healthy DFS radio as dead. A transient read failure mid-poll is not fatal either.
  Only a master still down when the budget expires is reported.
- That budget is SHARED across all deferred masters, not per-radio. CAC and provisioning
  run concurrently on the device, so a per-radio budget would multiply the wait by the
  fleet size - a controller with 20 dead CAP radios would stall an apply for half an hour.
- The deadline is measured against a real CLOCK, not against time spent sleeping. Slow or
  timing-out SSH reads burn real time too; counting only sleeps let the function overrun
  its budget exactly when reads were slowest. `now` and `sleep` are injectable so tests
  are deterministic, and a round cap means even a frozen clock cannot spin.
- A poll ROUND IS ATOMIC: once it starts, every unresolved radio is read in it. Checking
  the deadline mid-round judges the radios later in map order on their PREVIOUS round's
  result, so several DFS checks finishing near the deadline would see the first radio
  pass and the rest falsely reported dead. Check the deadline only BETWEEN rounds; the
  overrun is bounded by one round's reads.
- Virtual-vs-master is decided by asking the device for `master-interface`, never by
  guessing from a `-ssidN` suffix. If that lookup FAILS: do not touch the interface, and
  do not call it healthy either - report it, or a dead VAP hides behind a failed lookup.
- A still-dead VIRTUAL AP becomes an unmet requirement so a `role: router` apply FAILS.
  Reporting success for an SSID nobody can see is the bug being fixed.
- CAPsMAN has NO postcondition mechanism, so there a dead SSID is surfaced as a loud
  end-of-run summary instead. Do not claim CAPsMAN fails the apply - it does not.
- Both CAPsMAN summary calls must sit BEFORE the success banner and in the catch block.
  Placing one after the try/catch makes it dead code: the try returns and the catch
  throws. That happened once already and was caught in review.

**Router Role: MSS Clamping (on by default)**
- ONE mangle rule on `chain=forward`, commented `router:mss-clamp`, matching
  `out-interface-list=WAN` with `new-mss=clamp-to-pmtu`.
- **Do NOT add a matching ingress rule.** `clamp-to-pmtu` derives the MSS from the route
  toward the packet's DESTINATION. For a SYN-ACK matched on WAN ingress that destination
  is the LAN bridge, normally 1500, so it would clamp to 1460 no matter how narrow the
  uplink is. It looks like it covers the upload direction while doing nothing. An earlier
  revision of this feature shipped exactly that rule; it was removed after review.
- The upload direction is covered instead by the router's OWN ICMP "fragmentation needed"
  back to the LAN client. That ICMP is generated locally, one hop away, so it is rarely
  the one being filtered.
- `new-mss=clamp-to-pmtu`, never a fixed value: a no-op on a 1500-byte uplink instead
  of a permanent penalty. Verified valid syntax on RouterOS 7.18.2.
- Opt-out via `lan.mssClamp: false`. Validation rejects a non-boolean, because the
  setting is compared with `!== false` and a stringy `"false"` from YAML would read as
  ON and silently do the opposite of what was written.
- Objects are matched by EXACT comment, never `comment~"^router:mss-clamp"`. A prefix
  pattern would also delete someone's `router:mss-clamp-custom`.
- A rule that is already correct is left untouched. Re-applying does not remove and
  re-add it, so a working gateway is never briefly unclamped.
- Replacing a WRONG rule stages first: add under `router:mss-clamp-staged`, verify it
  read back correct, remove the old rule, then rename the staged one. A drifted rule may
  still be doing useful work (a fixed MSS beats no clamp), so it is never destroyed
  before the replacement is proven to exist.
- Recovery from an interrupted swap matters as much as the swap. If the process dies
  after the canonical rule is removed but before promotion, the verified staged rule IS
  the live clamp. The next apply ADOPTS it (renames it) rather than deleting it and
  adding fresh - deleting a proven-good rule risks leaving the gateway with none if the
  new add fails, which is the exact failure staging exists to prevent. Any other
  stranded staged rule is cleared, and clearing it must SUCCEED before staging proceeds.
- Two active clamp rules must never persist: a stranded staged rule is removed even when
  the canonical rule is already correct.
- The opt-out path removes BOTH comments and confirms BOTH are absent. Backup records
  `mssClamp: false` only when BOTH are absent, so a mid-swap device is not recorded as
  opted out - that would make the next apply deliberately remove a working rule.
- `mssClampRuleIsCurrent()` compares EXACT field values, parsed as `key=value`, and
  requires the rule to be enabled. Substring matching is not enough: `chain=forward-custom`
  contains `chain=forward`, `out-interface-list=WAN-backup` contains `out-interface-list=WAN`,
  and `tcp-flags=syn,!ack` contains `tcp-flags=syn`. All three look right and behave
  differently. A rule carrying `in-interface`/`in-interface-list` is rejected outright.
- Verification runs in BOTH states. Checking only when clamping is on would let a failed
  removal pass while the rule is still live.
- Backup records `mssClamp: false` only when the rule is absent. A read FAILURE is
  left unrecorded rather than guessed at: writing `false` on error would silently strip
  the clamp on the next apply.
- This is a fix for uplinks where path MTU discovery is blocked (PPPoE at 1492, many
  LTE bearers). It changes segment SIZE, never RATE. A slow uplink stays slow - see the
  carrier-policer note below before blaming MSS for a throughput complaint.
- NOT verified on a genuinely MTU-constrained uplink. The LTE bearer available for
  testing reports and carries 1500 bytes, so `clamp-to-pmtu` had nothing to clamp.

**Measuring A Backup WAN: The Router Does Not Use It (2026-08-25)**
- The router's OWN traffic follows the main routing table, so it leaves via the ACTIVE
  uplink. On a healthy router that is the wired WAN, never the LTE backup.
- So `/tool/fetch` on the router does NOT test the backup link. It tests the primary.
  A "router-originated over LTE" number collected that way is a wired number.
- To force router traffic onto a backup uplink, mark it in `chain=output`:
  ```
  /routing/table add name=t-lte fib
  /ip route add dst-address=0.0.0.0/0 gateway=lte1 routing-table=t-lte
  /ip firewall mangle add chain=output dst-address=<test-ip> action=mark-routing \
      new-routing-mark=t-lte passthrough=no
  ```
  Use `chain=prerouting src-address=<client>` for the same test from a LAN client. This
  isolates one source/destination pair on the backup link with no outage.
- Measure with `/interface get lte1 rx-byte` deltas, not with what the client reports.
- `/tool/sniffer` and `/tool/torch` are blocked unless device-mode allows them. Counter
  deltas, `/ping`, and firewall rule counters all still work and are usually enough.
- `/tool/fetch ... output=user` silently CAPS the result at 64512 bytes. It looks like a
  completed transfer. Use `output=none` to pull a whole file.

**A Uniform Byte Rate Is A Carrier Policer, Not A Config Bug (2026-08-25)**
- Symptom reported: LAN clients could not sustain a TCP transfer over the LTE backup.
  Small requests fine, 1MB "stalled". Real cause: the SIM was policed to ~63 kbit/s.
- What proved it, all measured on the live Chateau LTE6:
  - Forwarded (chain=forward, masqueraded) 7.9 KB/s vs router-originated (chain=output)
    8.1 KB/s. No forward-vs-output asymmetry at all.
  - MSS swept 1360/1200/1000/800/536 -> throughput unchanged. Rules out path MTU.
  - Disabling `router:forward-invalid` -> unchanged. Bypassing masquerade -> unchanged.
    `change-ttl set:64` (carrier tethering detection) -> unchanged.
  - APN swept `fast.t-mobile.com` / network-supplied / `h2g2`, and `ip-type=ipv4`. Each
    produced a NEW bearer IP in a different block. All gave 7.68 KB/s. The cap follows
    the SIM, not the session.
  - Radio was healthy throughout: RSSI -54dBm, SINR 19dB, LTE B4@20MHz.
- Discriminator worth reusing: ping the probe address DURING a transfer. RTT stayed
  30-45ms with 0% loss while throughput sat at 63 kbit/s. A queue/shaper inflates RTT; a
  policer drops without queueing. Flat RTT + low rate = policer = upstream, not local.
- `h2g2` DID attach here, contrary to the older note above. It was simply as slow as the
  rest, which is how it can look like it "did not work".

**Router Role: Interface Lists and Comment Conventions**
- Maintains the `WAN` and `LAN` interface lists that RouterOS defconf already uses. One NAT rule (`out-interface-list=WAN`) and one firewall rule cover every uplink.
- The `WAN` list member comment is the AUTHORITATIVE record: `wan:<name> type=... distance=... probe=... [apn=...]`.
- Why: routes only exist while a link is up. Reading settings back from routes alone drops an unplugged uplink from the backup. The list member is always present.
- Other comments: routes `wan:<name> probe` / `wan:<name> default`, NAT `router:masquerade`, filter `router:<purpose>`, DHCP/pool/address `router:lan`, notifier `router:wan-notify [state=<uplink>]`.
- Backup detects the role via the `router:masquerade` NAT rule, not via routes, for the same reason.
- RouterOS `print detail` renders comments as `;;; <comment>` lines, NOT as `comment="..."`. Parse with `recordComment()` in `lib/router.js`. Getting this wrong silently returns nothing.
- `/ip dns print` wraps a multi-server list onto unlabelled continuation lines. Collect lines until the next `label:`.

**Router Role: Lockout Safety**
- Changing `lan.address` cuts the SSH session doing the work. This repo already has a lockout history (VLAN filtering, 3 times).
- `addLanAddress()` runs before the DHCP server (which needs the address to exist). `removeStaleLanAddresses()` runs last and REFUSES to remove the address whose subnet contains `config.host`.
- Result: run 1 over the old address leaves both addresses live. Run 2 over the new address removes the old one. Never a moment with no reachable address.
- Firewall order is deliberate: accept established, drop invalid, accept ICMP, accept `in-interface-list=LAN`, and only THEN drop `in-interface-list=!LAN`. The drop rule is skipped entirely if the LAN list cannot be verified to contain `bridge`.
- Fasttrack is OFF by default (`lan.fasttrack: true` to enable). Fasttracked flows skip connection tracking, which slows how fast stale sessions clear after a failover.

**Router Role: The Management Plane Cannot Reach The WAN (v6.2.4)**
- Before this, every `/ip service` entry listened on `address=""` (any source). The ONLY
  thing keeping admin off the uplinks was one firewall rule, `router:input-drop-wan`.
  It worked - 34,937 packets dropped on the live device, zero WAN-side logins - but it
  is a single object. Delete it, reorder it, or add a permissive input rule above it and
  the whole management surface is exposed behind whatever password the device has.
- `configureManagementServices()` in `lib/router.js` binds EVERY `/ip service` entry to
  `networkOf(lan.address)`, so RouterOS's own accept path refuses an off-LAN connection.
  The firewall rule STAYS. Two layers, independent failure modes; do not remove either.
- Disabled services are bound too (`www-ssl` ships disabled). Binding only the enabled
  ones would leave a one-command path back to an exposed management plane.
- `telnet` and `ftp` are disabled: cleartext, and this tool drives devices over SSH.
  `lan.management.cleartext: true` keeps them, still LAN-bound.
- LAYER 2 BYPASSES ALL OF THAT. MAC-telnet and MAC-winbox run over ethernet frames -
  no IP, so neither `/ip service address=` nor the firewall input chain applies. An
  attacker on the WAN broadcast domain reaches them without an address. `/tool mac-server`,
  `/tool mac-server mac-winbox` and `/ip neighbor discovery-settings` are set to the `LAN`
  interface list and VERIFIED. RouterOS defconf already sets them; nothing enforced it.
  Gated on `lanListVerified` for the same reason the drop rule is: pointing MAC-winbox at
  a list without the bridge removes the recovery path that exists for this kind of mistake.
- RoMON is layer 2 too. It is REPORTED when enabled, not switched off: this tool does not
  own it and it is off from the factory. `/tool romon port add interface=<wan> forbid=yes`
  is the fix. Not implemented because device-mode blocked live verification on the test
  device, and an unverified device command is how v6.2.2 shipped broken.

**The Escape Hatch Cannot Express A WAN Address (the design tension, resolved)**
- Requirement was "no WAN admin access under ANY config a user writes", but a router
  managed across a VPN needs SOME way to widen access. Both hold only if the hatch's
  GRAMMAR cannot name a WAN source.
- `lan.management.allow` entries must be non-globally-routable: RFC1918, CGNAT
  (100.64.0.0/10, where Tailscale lives), link-local, loopback. See `PRIVATE_SCOPES`.
- Checked on the entry's NETWORK, not its address. `10.0.0.1/1` looks private and masks
  to `0.0.0.0/1` - half the internet. Testing the address would have waved it through.
- PRIVATE IS NOT SUFFICIENT ON ITS OWN. The test device's own `ether1` sits on
  192.168.4.0/22 behind another router, and CGNAT is a real WAN range on some ISPs. So
  every entry is ALSO compared at apply time against the addresses actually on the
  uplinks (`readWanAddresses()`), and one covering a live uplink address is dropped and
  reported. A DHCP/LTE address is not in the config; only a runtime check can see it.
- If `lan.address` ITSELF covers an uplink address (LAN 192.168.0.0/16, WAN 192.168.4.24),
  the entry is KEPT and reported. Dropping it would leave an empty list, which means no
  restriction at all - strictly worse. The firewall covers the overlap.

**Router Role: The Lockout Guard On /ip service (outranks the exposure it fixes)**
- This tool connects over SSH. Restricting `/ip service` while the operator is reaching
  the device from somewhere the restriction excludes locks them out of a REMOTE gateway
  permanently. That is far worse than the exposure being closed.
- Ask the DEVICE who is connected: `/user active print terse` ->
  `0 when=... name=admin address=192.168.80.199 via=ssh group=full`. Unless EVERY active
  session is covered by the allow list, restrict nothing.
- Use the device's view, never this process's idea of its own source address. A jump
  host, a NAT gateway or a VPN concentrator all rewrite it on the way; only the router
  knows what it will compare `address=` against. (`conn.sock.localAddress` was considered
  and rejected for exactly that reason.)
- "Cannot tell" == "not covered". An unreadable session list, or an EMPTY one, both mean
  restrict nothing. This session must appear in that list, so empty means the command or
  the parse is broken, not that nobody is connected.
- Any uncovered session blocks it, not just ours. There is no reliable way to tell which
  active session belongs to this process.
- Skipping is a WARNING, not an unmet requirement. `configureRouterFirewall()` already
  skips its drop rule the same way when it cannot verify the LAN list. Failing an
  otherwise-good apply because a SAFETY guard fired is its own kind of breakage, and the
  firewall rule still stands.
- Changing `lan.address` therefore skips the restriction on run 1 (operator is on the old
  subnet) and lands it on run 2. Same two-run shape as the LAN address migration.
- SSH is bound LAST, after every other service proved the command shape. If it reads back
  EXCLUDING the current session, it is cleared again automatically - RouterOS applies
  `address=` to new connections only, so a wrong value does not drop the live session and
  the lockout would not surface until the next connect. The apply still FAILS. If the
  clear also fails, the problem is prefixed `URGENT:`.
- A wrong ssh value that still COVERS the session is reported but NOT cleared. Reopening
  the management plane to answer a mismatch that is not a lockout is the wrong trade.

**RouterOS Reports Invalid Arguments On STDOUT, So mt.exec Resolves (v6.2.4)**
- Verified live: `/ip service set [find name="ftp"] address="192.168.80.1/24"` returns
  `invalid value for argument address: ...` as normal output. `lib/ssh-client.js` rejects
  only when STDERR has data, so the promise RESOLVES and the try/catch never fires.
- Consequence: "the command did not throw" is NOT evidence it did anything. Every write in
  `configureManagementServices()` is verified by reading it back. Assume this for any new
  device write.
- `address=` also rejects any value with a host bit set ("value of address must have all
  host bits zero"), which is why the LAN network is masked with `networkOf()` before it is
  sent, and why user-supplied `allow` entries are masked rather than passed through.

**RouterOS Renders One Address List Two Different Ways**
- `print terse` -> `address=192.168.80.0/24,100.64.0.0/10` (COMMA, unquoted when set,
  but `address=""` when empty in `print detail`).
- `:put [/ip service get [find name="ssh"] address]` -> `192.168.80.0/24;100.64.0.0/10`
  (SEMICOLON - `:put` renders an array). Both reach `parseAddressList()`. Handling only
  one reads a two-entry list as one malformed entry, so verification passes or fails at
  random.
- `/tool mac-server print terse` is a SYNTAX ERROR. Those settings must be read with
  `:put [/tool mac-server get allowed-interface-list]`.

**Backup Records The Restriction Only When It Is Demonstrably In Place**
- `backupRouterConfig()` reads `lan.management` only when the `ssh` service actually has
  an address list. A device whose ssh still listens on any address has simply never been
  hardened.
- Recording `cleartext: true` off the back of an unhardened device would let a
  backup/restore cycle silently carry "leave telnet on" forward for ever. Same shape as
  the `mssClamp: false` rule: never record a default that would UNDO hardening.
- The LAN network is filtered out of `allow` - `lan.address` already implies it.

**VAP Settle Budget Is A Poll, Not A Fixed Wait (v6.2.4, fixing 6.2.3)**
- 6.2.3 waited a flat `delayMs=3000` after toggling a virtual AP, `attempts=3`, so about
  6s of settle. TOO SHORT, and it fails in the wrong direction.
- Production evidence, same live Chateau, two real applies:
  - Apply A: retried twice, exhausted the budget, reported `wifi2-ssid2 is configured but
    not running`, apply exited INCOMPLETE - and the interface came up moments later. A
    FALSE NEGATIVE breaks any automation gating on the exit code.
  - Apply B: `retrying (1/2)` then recovered inside the budget and passed. So: marginal.
  - Separately measured: a VAP toggled from a DISABLED state recovers in 3.9s. Recovery
    after a FRESH create is evidently slower than that.
- Now: toggle once, then POLL `running` until it comes up or a 60s budget expires.
- Why 60s. Polling costs NOTHING on a healthy interface - it returns on the first read -
  so the budget is only spent on a genuine failure. That makes a generous budget nearly
  free, which is why it is not tuned tightly to the observed ~6s. It stays under the 90s
  the master re-check allows for a DFS availability check.
- The budget is SHARED across retries (`timeoutMs / (attempts - 1)` each), not granted
  per retry. Raising `attempts` divides it instead of multiplying the wait.
- Attempt 1 is a plain read, never a poll: the common case is already-up and must not pay
  a poll cycle. Verified by asserting the fake clock never advances for a healthy VAP.
- The honest failure is KEPT. An expired budget still reports the problem, still with the
  device's own `;;; failed to create interface` explanation. Do not "fix" this into
  waiting longer and then claiming success - that was the bug 6.2.2 existed to fix.
- The master-radio property is UNCHANGED: a master is never toggled and never enters the
  settle poll. It carries every associated client, very possibly including the operator.
- `pollUntilRunning()` in `lib/wifi-config.js` is now shared by `ensureWifiInterfaceUp()`
  and `recheckPendingMasters()`. Do not write a third copy. Its awkward properties are
  all load-bearing: ONE shared deadline for all names (a controller with 20 dead radios
  would otherwise stall for timeout x 20); time measured against the WALL CLOCK, not
  accumulated sleep (a slow SSH read burns real time, and counting only sleeps ran past
  the budget exactly when reads were slowest); ATOMIC rounds (breaking out mid-round
  judges later names on a stale previous-round result); and a read failure is NOT fatal.

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
- Each uplink's probe address should differ from every `lan.dns.servers` entry. The probe is pinned by a /32 with no health check, so a resolver pinned to a failing uplink stalls queries until they time out. This is a WARNING, not an error - it degrades DNS, it does not break it, and erroring rejected a working production config on upgrade (shipped broken in v6.1.1).
- Never let two uplinks share a probe. Two /32 routes on one destination with different gateways make the recursive lookup follow whichever won. `DEFAULT_PROBES` has four entries; beyond that `normalizeWans()` throws rather than reusing one.
- Clear `WAN` list members by comment (`[find list=WAN comment~"^wan:"]`), not by the interfaces in the current config. Member comments are authoritative for backup, so a stale member resurrects a deleted uplink.
- No interface ever gets a NAMED datapath. `configureWifiInterface()` writes `datapath.bridge=... datapath.vlan-id=N` inline. Read the VLAN off the interface with `/(?:datapath)?\.vlan-id=(\d+)/` - a named-datapath lookup always returns nothing.
- `backup.js` deletes `managementInterfaces`/`disabledInterfaces` for routers. Any consumer must guard for that; `backup-multiple-devices.js` crashed on it.
- Run `npm test` (`test/router.test.js`) before touching parsing or validation. Its fixtures are real captured RouterOS output.

**NEVER Interpolate Config Values Into Device Commands (v6.1.2)**
- Use `lib/routeros-args.js` for EVERY value that reaches a device command. `escapeMikroTik()` alone is not enough and was not wired up at all in `lib/router.js` before v6.1.2.
- Two contexts, two treatments:
  - Quoted (`comment="..."`, `password="..."`): wrap with `q()`, which escapes `\`, `"` and `$`.
  - Unquoted (`interface=ether1`, `distance=2`, `lease-time=12h`): escaping cannot help. Use `ifaceName()`, `ipv4()`, `cidr()`, `ipRange()`, `duration()`, `integer()`, `ipv4List()`. They THROW on anything unexpected - that is deliberate, a bad value must stop the apply.
- This is not hypothetical for legitimate configs: an ISP PPPoE password containing `"` or `$` produced a malformed command.

**Validate Normalized Values, Not What The User Typed**
- `normalizeWans()` fills in `distance` and `probe`. Validating only explicit fields let an implicit default collide with an explicit one, and let the common `lan.dns: [8.8.8.8]` + default probe `8.8.8.8` case through.
- `lib/validate-router.js` calls `normalizeWans()` and checks the result.

**Router Role: Ownership and Verification Rules (v6.1.2)**
- Delete ONLY what carries this tool's comment. `removeStaleLanAddresses()` removes just `router:lan` and the factory `defconf` address; static WAN removal is scoped to `wan:<name>`. A hand-added recovery address on the bridge must survive.
- Never delete the old LAN address until the new one is READ BACK from the device. `addLanAddress()` returns a boolean and `configureRouter()` must honour it.
- Never add the firewall drop rule until `router:input-lan` is confirmed present. `execWithWarning()` swallows failures, so "we issued the command" is not evidence.
- Resolve all WAN gateways BEFORE removing any routes, and replace each uplink's routes independently. Removing everything up front made an apply during an outage strip a down uplink's routes with nothing to restore.
- `verifyRouterState()` runs at the end and THROWS on unmet postconditions. Without it, apply reported success with no route, no NAT and no DHCP.

**RouterOS `set` Does Not Clear Unspecified Properties**
- Omitting `datapath.vlan-id` leaves the old VLAN in place, so a tagged SSID could never become untagged. Use the `!datapath.vlan-id` unset form.
- That syntax is not confirmed across all RouterOS builds and this path configures every SSID for every role, so `configureWifiInterface()` retries without it on a syntax error rather than failing the apply.

**Backup Must Ignore What The Device Is Not Using (v6.1.2)**
- `print detail` NEVER emits `disabled=yes`. Disabled is an `X` in the flag field, which is followed by a `key=value`, a `;;;` comment, OR a line break. Use `isDisabledRecord()` in `lib/backup.js`; do not assume key=value follows on the same line. The old `disabled=yes` check never matched, so disabled radios were backed up as if broadcasting.
- Skip band settings for a disabled radio too, or the backup carries channel/width the source config never declared.
- A bridge port whose interface no longer resolves prints as `*2`. Filter LAN ports through `IDENTIFIER` - `interface=*2` is not usable in a config.
- `validateRouterConfig()` returns `{errors, warnings}`, not an array.
- Split records with `splitDetailRecords()` from `lib/router.js`. A hand-rolled "line starts with 0-5" loop silently merged interfaces 6+ on real devices.

**Command Encoding Is Not Finished (as of v6.1.2)**
- DONE: `lib/router.js`, `lib/wifi-config.js` (`configureWifiInterface` AND `applyBandSettings`).
- NOT DONE: ~40 sites in `lib/configure.js`, `lib/infrastructure.js`, `lib/capsman.js` - bond names, interface names, VLAN ids, syslog server/topics, identity, MAC addresses.
- Lower risk (low-entropy identifiers, and the config author already holds device credentials) but still real. Left undone because those paths serve a production AP fleet that could not be tested.
- Find remaining sites: look for `${...}` inside a template literal passed to `mt.exec()` where the value is not wrapped in `q()`/`ifaceName()`/`integer()`/etc.

**Probe/Resolver Overlap: Severity Depends On What Survives**
- Some resolver not a probe -> WARNING (a fallback exists).
- Pinned resolvers span 2+ uplinks -> WARNING (one stays reachable whenever any uplink is live). This is the common real deployment.
- Every resolver pinned to ONE uplink -> ERROR (that uplink losing its path takes DNS out entirely).
- v6.1.1 made all overlap an error and broke a working production config; the first correction made it all a warning, which promised a fallback that may not exist. Neither extreme is right.

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
6. Create the GitHub release object, which is what publishes the image:
   `gh release create vX.Y.Z --title "vX.Y.Z - Short Description" --notes "..."`

**Pushing the tag publishes nothing.** `.github/workflows/publish.yml` triggers on
`release: published`, not on tag push. Step 6 is the step that builds and pushes the
Docker image. A tag with no release leaves the previous image sitting at `:latest`.
The workflow can also be run by hand via `workflow_dispatch`.

Release title convention: `vX.Y.Z - Short Description`.

### Docker Image

- Multi-stage build with Node.js Alpine
- Entrypoint: `docker-entrypoint.sh` handles help/example/example-multiple/example-router/apply
- Published to the GitHub Container Registry, `ghcr.io/nickborgers/mikrotik-as-wap-configurator`, when a GitHub release is published (NOT Docker Hub, and NOT on tag push)
- Image tags come from the git tag with the leading `v` stripped, via `docker/metadata-action` semver patterns: `6.1.0`, `6.1`, `6`, plus `latest`. Pull `:6.1.0`, not `:v6.1.0`
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

**`test()` in test/router.test.js DOES NOT AWAIT its callback.** An `async` test body is
counted as a pass whatever it asserts, and a failed assertion surfaces only as an
unhandled rejection. Do the `await` OUTSIDE the `test()` call and assert on the result
synchronously, which is what most of the file already does.


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