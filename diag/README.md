# Diagnostic Scripts

Utility scripts for troubleshooting MikroTik WiFi configuration.

## Available Scripts

### check-status.js
Shows detailed configuration of WiFi interfaces, datapaths, and bridge ports.

```bash
node diag/check-status.js <host> <username> <password>
```

**Example:**
```bash
node diag/check-status.js 192.168.88.1 admin admin
```

**Output:**
- WiFi interface configurations
- WiFi datapath configurations
- Bridge port memberships

### check-running.js
Monitors actual runtime status of WiFi interfaces and shows connected clients.

```bash
node diag/check-running.js <host> <username> <password>
```

**Example:**
```bash
node diag/check-running.js 192.168.88.1 admin admin
```

**Output:**
- Active client registrations
- Master interface runtime status (channel, state, peers)
- Virtual interface runtime status
- Actual broadcasting state

### check-device.js
Basic device connectivity check.

```bash
node diag/check-device.js
```

### check-virtuals.js
Checks virtual WiFi interface status.

```bash
node diag/check-virtuals.js
```

### wait-for-device.js
Waits for device to come online after reboot.

```bash
node diag/wait-for-device.js <password>
```

## Docker Usage

These scripts are included in the Docker image:

```bash
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator \
  node /app/diag/check-status.js 192.168.88.1 admin password
```

## Troubleshooting Tips

**SSIDs not broadcasting?**
1. Run `check-running.js` to see actual runtime state
2. Look for `state: running` in the monitor output
3. Check for DFS messages on 5GHz interfaces

**Configuration not applied?**
1. Run `check-status.js` to verify interface configurations
2. Check datapath VLAN IDs match your config
3. Verify bridge port memberships

**Devices can't connect?**
1. Run `check-running.js` to see registration table
2. Verify SSIDs are in `state: running`
3. Check security settings (WPA2-PSK, passphrase)
