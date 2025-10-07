# Getting Started

## Quick Answer

**Use the same script for everything:**

```bash
./apply-config.js config.yaml
```

This works for:
- ✅ Fresh out-of-box devices
- ✅ Already-deployed devices
- ✅ Configuration changes
- ✅ Adding/modifying SSIDs

The script is **idempotent** - it safely handles both new and existing configurations.

## First Time Setup (Fresh Device)

### Step 1: Connect to the Device

Fresh MikroTik devices typically have:
- **IP Address**: 192.168.88.1
- **Username**: admin
- **Password**: (empty) or check the device label

Connect via Ethernet and access the device:
```bash
ssh admin@192.168.88.1
```

Set a password when prompted (you'll need this for the configuration).

### Step 2: Create Your Configuration

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

```yaml
device:
  host: 192.168.88.1        # Or use DHCP IP from your network
  username: admin
  password: YOUR-PASSWORD   # Password you just set

managementInterfaces:
  - ether1

disabledInterfaces:
  - ether2

ssids:
  - ssid: MyNetwork
    passphrase: your-wifi-password
    vlan: 100
    bands:
      - 2.4GHz
      - 5GHz
```

### Step 3: Apply Configuration

```bash
./apply-config.js config.yaml
```

The script will:
1. Connect to the device
2. Configure bridge ports
3. Set up WiFi SSIDs on specified bands
4. Keep management access safe

### Step 4: Verify

Check that SSIDs are broadcasting:
- Look for your SSID(s) on WiFi devices
- Connect using the passphrase from your config
- SSH should still work at the management IP

## Making Changes (Already Deployed Device)

### To Change SSIDs, Add Networks, or Modify Settings:

1. **Edit your config.yaml**:
   ```yaml
   ssids:
     - ssid: MyNetwork          # Existing SSID
       passphrase: newpassword  # Changed password
       vlan: 100
       bands: [2.4GHz, 5GHz]

     - ssid: Guest-WiFi         # New SSID
       passphrase: guestpass
       vlan: 200
       bands: [2.4GHz, 5GHz]
   ```

2. **Apply the configuration**:
   ```bash
   ./apply-config.js config.yaml
   ```

The script will:
- ✅ Update existing SSIDs with new settings
- ✅ Add new SSIDs
- ✅ Preserve management access
- ✅ Not cause lockouts

**Note**: The script currently **overwrites** WiFi interface configurations. If you have 2 SSIDs and both specify `2.4GHz`, the last one in the config will be applied to wifi1.

## Common Scenarios

### Scenario 1: Add a Guest Network

```yaml
ssids:
  - ssid: MyNetwork
    passphrase: mainpassword
    vlan: 100
    bands: [2.4GHz, 5GHz]

  # Add this:
  - ssid: Guest
    passphrase: guestpassword
    vlan: 200
    bands: [2.4GHz, 5GHz]
```

Run: `./apply-config.js config.yaml`

### Scenario 2: Change WiFi Password

```yaml
ssids:
  - ssid: MyNetwork
    passphrase: new-secure-password  # Updated
    vlan: 100
    bands: [2.4GHz, 5GHz]
```

Run: `./apply-config.js config.yaml`

### Scenario 3: 5GHz Only Network

```yaml
ssids:
  - ssid: FastNetwork
    passphrase: password
    vlan: 100
    bands: [5GHz]  # Only on 5GHz for speed
```

Run: `./apply-config.js config.yaml`

## Device Discovery

If you don't know the device IP:

**On Factory Fresh Device:**
- Connect Ethernet to ether1
- Device should be at 192.168.88.1
- Or check your router's DHCP leases

**On Deployed Device:**
```bash
# If it got DHCP address, check your router
# Or use MikroTik neighbor discovery
# Or check device label for default IP
```

## Troubleshooting

### Can't Connect to Device

1. **Check IP address**:
   - Factory default: 192.168.88.1
   - Or check DHCP leases on your router

2. **Check password**:
   - Fresh devices: empty or password on label
   - After initial setup: password you set

3. **Check network**:
   - Connected via ether1 (trunk port)
   - Same subnet as device

### Configuration Not Working

1. **Validate config**:
   ```bash
   ./apply-config.js config.yaml
   ```
   Will show validation errors if any

2. **Check device accessibility**:
   ```bash
   ssh admin@<device-ip>
   /interface/wifi print
   ```

3. **Wait for WiFi**:
   - WiFi changes may take 10-30 seconds
   - Check for SSIDs after waiting

### Multiple SSIDs on Same Band

Current limitation: If you configure multiple SSIDs with the same band, only the last one will be applied to that interface.

**Example (won't work as expected):**
```yaml
ssids:
  - ssid: Network1
    bands: [2.4GHz]  # This will be overwritten

  - ssid: Network2
    bands: [2.4GHz]  # This will be on wifi1
```

**Workaround**: Use different bands or accept that only one SSID per band is supported.

## Best Practices

1. **Keep config.yaml in version control** (but .gitignore passwords!)
2. **Test on one device first** before deploying to many
3. **Always ensure management interface is in config** (ether1)
4. **Use strong passphrases** (12+ characters)
5. **Document your VLAN assignments** in comments

## Helper Scripts

- `wait-for-device.js <password>` - Wait for device to come online
- `configure-device.sh <password>` - Automated first-time setup

## Summary

**One script does it all:**
```bash
./apply-config.js config.yaml
```

Whether you're:
- Setting up a new device
- Changing an SSID
- Adding a guest network
- Updating passwords

The same script handles everything safely!
