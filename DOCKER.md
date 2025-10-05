# Docker Usage Guide

## Quick Start

### 1. Get Example Configuration

```bash
docker run nickborgers/mikrotik-as-wap-configurator example > config.yaml
```

### 2. Edit Configuration

Edit `config.yaml` with your device settings:

```yaml
device:
  host: 192.168.88.1
  username: admin
  password: your-password

managementInterfaces:
  - ether1
  - ether2

ssids:
  - ssid: MyNetwork
    passphrase: wifi-password
    vlan: 100
    bands:
      - 2.4GHz
      - 5GHz
```

### 3. Apply Configuration

```bash
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  nickborgers/mikrotik-as-wap-configurator
```

## Usage Examples

### Show Help

```bash
docker run nickborgers/mikrotik-as-wap-configurator help
```

### Get Example Configuration

```bash
docker run nickborgers/mikrotik-as-wap-configurator example > config.yaml
```

### Apply to Default Device

```bash
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  nickborgers/mikrotik-as-wap-configurator
```

### Apply to Specific Device IP

```bash
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  nickborgers/mikrotik-as-wap-configurator 192.168.1.50
```

### Using Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  mikrotik-config:
    image: nickborgers/mikrotik-as-wap-configurator:latest
    volumes:
      - ./config.yaml:/config/config.yaml:ro
    network_mode: bridge  # Needs network access to reach devices
```

Run:
```bash
docker-compose run --rm mikrotik-config
```

## Volume Mounts

The container expects your configuration at `/config/config.yaml`:

```bash
-v $(pwd)/config.yaml:/config/config.yaml
```

**On Windows (PowerShell):**
```powershell
docker run -v ${PWD}/config.yaml:/config/config.yaml `
  nickborgers/mikrotik-as-wap-configurator
```

**On Windows (CMD):**
```cmd
docker run -v %cd%/config.yaml:/config/config.yaml ^
  nickborgers/mikrotik-as-wap-configurator
```

## Network Requirements

⚠️ **Important**: This container needs network access to reach your MikroTik device.

**Do NOT use** `--network=none` with this container.

The container must be able to reach your MikroTik device's IP address via SSH (port 22).

## Image Tags

- `latest` - Latest stable release
- `X.Y.Z` - Specific version (e.g., `2.0.0`)
- `X.Y` - Major.minor version (e.g., `2.0`)
- `X` - Major version (e.g., `2`)

**Recommended for production:**
```bash
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  nickborgers/mikrotik-as-wap-configurator:2.0.0
```

## Multi-Architecture Support

The image supports:
- `linux/amd64` (x86_64)
- `linux/arm64` (ARM 64-bit, e.g., Raspberry Pi 4)

Docker will automatically pull the correct architecture for your system.

## Building Locally

```bash
# Clone the repository
git clone git@github.com:NickBorgers/mikrotik-as-wap-configurator.git
cd mikrotik-as-wap-configurator

# Build the image
docker build -t mikrotik-config .

# Run your local build
docker run -v $(pwd)/config.yaml:/config/config.yaml mikrotik-config
```

## Troubleshooting

### Config File Not Found

**Error:**
```
ERROR: No configuration file found at /config/config.yaml
```

**Solution:**
Ensure you're mounting the config file correctly:
```bash
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  nickborgers/mikrotik-as-wap-configurator
```

### Cannot Connect to Device

**Error:**
```
✗ Configuration Error: Timed out while waiting for handshake
```

**Possible causes:**
1. Device IP is incorrect
2. Device is not reachable from container
3. Firewall blocking SSH (port 22)
4. Wrong credentials

**Solutions:**
- Verify device IP: `ping <device-ip>`
- Check SSH access: `ssh admin@<device-ip>`
- Update `config.yaml` with correct IP and password
- Ensure container has network access (don't use `--network=none`)

### Permission Denied on Windows

If you get permission errors on Windows, try:

1. Use absolute paths:
   ```powershell
   docker run -v C:\path\to\config.yaml:/config/config.yaml `
     nickborgers/mikrotik-as-wap-configurator
   ```

2. Share the drive in Docker Desktop settings

## Security Considerations

### Credentials in Config File

Your `config.yaml` contains passwords. Best practices:

1. **Don't commit config.yaml to git**
   - Already in `.gitignore`

2. **Use environment variables** (future feature):
   ```yaml
   device:
     password: ${MIKROTIK_PASSWORD}
   ```

3. **Restrict file permissions**:
   ```bash
   chmod 600 config.yaml
   ```

### Network Security

- Container needs network access to SSH to devices
- Only exposes SSH client (port 22 outbound)
- No inbound ports exposed
- No services running

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Configure MikroTik Devices

on:
  push:
    paths:
      - 'config.yaml'

jobs:
  configure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure MikroTik
        run: |
          docker run -v $(pwd)/config.yaml:/config/config.yaml \
            nickborgers/mikrotik-as-wap-configurator
```

### GitLab CI Example

```yaml
configure-mikrotik:
  image: docker:latest
  services:
    - docker:dind
  script:
    - docker run -v $(pwd)/config.yaml:/config/config.yaml
        nickborgers/mikrotik-as-wap-configurator
```

## Advanced Usage

### Configure Multiple Devices

```bash
for ip in 192.168.1.{10..20}; do
  echo "Configuring $ip..."
  docker run -v $(pwd)/config.yaml:/config/config.yaml \
    nickborgers/mikrotik-as-wap-configurator $ip
done
```

### Using Secrets Manager

```bash
# Fetch config from secrets manager
aws secretsmanager get-secret-value \
  --secret-id mikrotik-config \
  --query SecretString --output text > config.yaml

# Apply configuration
docker run -v $(pwd)/config.yaml:/config/config.yaml \
  nickborgers/mikrotik-as-wap-configurator

# Clean up
rm config.yaml
```

## Support

- **Documentation**: [README.md](README.md)
- **Getting Started**: [GETTING-STARTED.md](GETTING-STARTED.md)
- **Issues**: https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues
- **Docker Hub**: https://hub.docker.com/r/nickborgers/mikrotik-as-wap-configurator
