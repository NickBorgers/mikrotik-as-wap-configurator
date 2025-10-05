#!/bin/sh
set -e

# Function to show usage
show_usage() {
    cat << 'EOF'
╔════════════════════════════════════════════════════════════════════╗
║         MikroTik Network Configuration as Code - Docker            ║
╚════════════════════════════════════════════════════════════════════╝

USAGE:
  docker run -v $(pwd)/config.yaml:/config/config.yaml \
    nickborgers/mikrotik-as-wap-configurator

EXAMPLES:

  1. Get example configuration:
     docker run nickborgers/mikrotik-as-wap-configurator example > config.yaml

  2. Apply configuration:
     docker run -v $(pwd)/config.yaml:/config/config.yaml \
       nickborgers/mikrotik-as-wap-configurator

  3. Configure specific device:
     docker run -v $(pwd)/config.yaml:/config/config.yaml \
       nickborgers/mikrotik-as-wap-configurator 192.168.1.50

  4. Show this help:
     docker run nickborgers/mikrotik-as-wap-configurator help

CONFIGURATION FILE:

Create a config.yaml file with your device settings:

---
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

  - ssid: Guest-WiFi
    passphrase: guest-password
    vlan: 200
    bands:
      - 2.4GHz
      - 5GHz
---

VOLUME MOUNT:
  Mount your config.yaml to /config/config.yaml

NETWORK:
  Container needs network access to reach MikroTik device.
  Do NOT use --network=none for this container.

MORE INFO:
  https://github.com/yourusername/network-config-as-code

EOF
}

# Function to show example config
show_example() {
    cat /app/config.example.yaml
}

# Main logic
case "${1:-help}" in
    help)
        show_usage
        exit 0
        ;;
    example)
        show_example
        exit 0
        ;;
    *)
        # Check if config file exists
        if [ ! -f /config/config.yaml ]; then
            echo "ERROR: No configuration file found at /config/config.yaml"
            echo ""
            echo "Mount your config file with:"
            echo "  -v \$(pwd)/config.yaml:/config/config.yaml"
            echo ""
            echo "Or get an example configuration:"
            echo "  docker run nickborgers/mikrotik-as-wap-configurator example > config.yaml"
            echo ""
            exit 1
        fi

        # Apply configuration
        if [ "$1" = "apply" ] || [ -z "$1" ]; then
            # No target IP specified
            node /app/apply-config.js /config/config.yaml
        else
            # Target IP specified as argument
            node /app/apply-config.js /config/config.yaml "$1"
        fi
        ;;
esac
