# Device Configuration Migration

## Summary
The device `mikrotik-managed-wap-north.nickborgers.net` has been successfully added to the unified `multiple-devices.yaml` configuration file.

## Configuration Details

### Device Location
The device is now the 4th entry in `multiple-devices.yaml` with the following configuration:
- **Host**: mikrotik-managed-wap-north.nickborgers.net
- **Management Interface**: ether1
- **Disabled Interface**: ether2

### SSID Configuration
1. **PartlyPrimary**
   - VLAN: 100
   - Bands: 2.4GHz and 5GHz

2. **PartlySonos**
   - VLAN: 100
   - Bands: 2.4GHz only

3. **PartlyWork**
   - VLAN: 50
   - Bands: 2.4GHz and 5GHz

## Management
All MikroTik wireless access points are now managed through the unified configuration:

```bash
# Apply to all devices
./apply-multiple-devices.js multiple-devices.yaml

# Apply to all devices in parallel
./apply-multiple-devices.js multiple-devices.yaml --parallel
```

## Total Devices
The `multiple-devices.yaml` file now contains 4 devices:
1. indoor-wap-south.nickborgers.net
2. outdoor-wap-east.nickborgers.net
3. outdoor-wap-north.nickborgers.net
4. mikrotik-managed-wap-north.nickborgers.net (newly added)