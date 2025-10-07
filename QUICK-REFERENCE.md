# Quick Reference

## The One Command You Need

```bash
./apply-config.js config.yaml
```

Use this for **everything**:
- Fresh device setup
- Configuration changes
- Adding SSIDs
- Updating passwords

## Common Tasks

### First Time Setup
```bash
# 1. Copy example config
cp config.example.yaml config.yaml

# 2. Edit config.yaml with your settings
vim config.yaml

# 3. Apply
./apply-config.js config.yaml
```

### Change WiFi Password
```yaml
# In config.yaml, update:
ssids:
  - ssid: MyNetwork
    passphrase: new-password  # Change this
    vlan: 100
    bands: [2.4GHz, 5GHz]
```
```bash
./apply-config.js config.yaml
```

### Add Guest Network
```yaml
# In config.yaml, add:
ssids:
  - ssid: Guest-WiFi
    passphrase: guestpass
    vlan: 200
    bands: [2.4GHz, 5GHz]
```
```bash
./apply-config.js config.yaml
```

### Configure Different Device
```bash
./apply-config.js config.yaml 192.168.1.50
```

## Configuration Template

```yaml
device:
  host: 192.168.88.1
  username: admin
  password: YOUR-PASSWORD

managementInterfaces:
  - ether1

disabledInterfaces:
  - ether2

ssids:
  - ssid: NetworkName
    passphrase: wifi-password
    vlan: 100
    bands:
      - 2.4GHz  # Include for 2.4GHz
      - 5GHz    # Include for 5GHz
```

## Band Options

- `[2.4GHz, 5GHz]` - Both bands (most common, seamless roaming)
- `[2.4GHz]` - 2.4GHz only (better range, IoT devices)
- `[5GHz]` - 5GHz only (faster speeds, less interference)

## Device Connection

**Fresh device:**
- IP: 192.168.88.1
- User: admin
- Password: (empty or on device label)

**Deployed device:**
- Check DHCP leases on your router
- Or use the IP you configured

## Files

- `config.yaml` - Your device configuration
- `config.example.yaml` - Template to copy
- `GETTING-STARTED.md` - Detailed setup guide
- `README.md` - Full documentation

## Troubleshooting

**Device not accessible?**
```bash
ssh admin@192.168.88.1  # Try default IP
```

**Config not applying?**
- Check validation errors in script output
- Verify device IP is correct
- Ensure SSH access works

**WiFi not broadcasting?**
- Wait 30 seconds after applying config
- Check SSIDs are in your config
- Verify bands are specified correctly

## Need Help?

- First time? → Read [GETTING-STARTED.md](GETTING-STARTED.md)
- Details? → Read [README.md](README.md)
- Changes? → Read [CHANGELOG.md](CHANGELOG.md)
