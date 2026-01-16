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
    ghcr.io/nickborgers/mikrotik-as-wap-configurator [command] [options]

COMMANDS:
  apply              Apply single-device configuration (default)
  apply-multiple     Apply multi-device configuration
  example            Output example single-device config.yaml
  example-multiple   Output example multiple-devices.yaml
  help               Show this help message

SINGLE-DEVICE EXAMPLES:

  1. Get example configuration:
     docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator example > config.yaml

  2. Apply configuration:
     docker run -v $(pwd)/config.yaml:/config/config.yaml \
       ghcr.io/nickborgers/mikrotik-as-wap-configurator

  3. Configure specific device:
     docker run -v $(pwd)/config.yaml:/config/config.yaml \
       ghcr.io/nickborgers/mikrotik-as-wap-configurator apply 192.168.1.50

MULTI-DEVICE EXAMPLES:

  1. Get example multi-device configuration:
     docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator example-multiple > multiple-devices.yaml

  2. Apply to multiple devices (sequential with 5s delay):
     docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
       ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple

  3. Apply in parallel (faster, but causes network-wide outage):
     docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
       ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple --parallel

  4. Custom delay between devices:
     docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
       ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple --delay 10

MULTI-DEVICE OPTIONS:
  --parallel       Apply configurations in parallel (faster but network-wide outage)
  --delay <secs>   Wait between devices for client roaming (default: 5)
  --no-delay       Skip delay between devices

VOLUME MOUNTS:
  Single device:   -v $(pwd)/config.yaml:/config/config.yaml
  Multi-device:    -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml

NETWORK:
  Container needs network access to reach MikroTik devices.
  Do NOT use --network=none for this container.

MORE INFO:
  https://github.com/nickborgers/network-config-as-code

EOF
}

# Function to show example config
show_example() {
    cat /app/config.example.yaml
}

# Function to show example multi-device config
show_example_multiple() {
    cat /app/multiple-devices.example.yaml
}

# Main logic
case "${1:-apply}" in
    help)
        show_usage
        exit 0
        ;;
    example)
        show_example
        exit 0
        ;;
    example-multiple)
        show_example_multiple
        exit 0
        ;;
    apply-multiple)
        # Check if multi-device config file exists
        if [ ! -f /config/multiple-devices.yaml ]; then
            echo "ERROR: No configuration file found at /config/multiple-devices.yaml"
            echo ""
            echo "Mount your config file with:"
            echo "  -v \$(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml"
            echo ""
            echo "Or get an example configuration:"
            echo "  docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator example-multiple > multiple-devices.yaml"
            echo ""
            exit 1
        fi

        # Shift off the command and pass remaining args
        shift
        node /app/apply-multiple-devices.js /config/multiple-devices.yaml "$@"
        ;;
    apply|*)
        # Check if config file exists
        if [ ! -f /config/config.yaml ]; then
            echo "ERROR: No configuration file found at /config/config.yaml"
            echo ""
            echo "Mount your config file with:"
            echo "  -v \$(pwd)/config.yaml:/config/config.yaml"
            echo ""
            echo "Or get an example configuration:"
            echo "  docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator example > config.yaml"
            echo ""
            exit 1
        fi

        # Apply single-device configuration
        if [ "$1" = "apply" ]; then
            shift
        fi
        if [ -z "$1" ]; then
            node /app/apply-config.js /config/config.yaml
        else
            # Target IP specified as argument
            node /app/apply-config.js /config/config.yaml "$1"
        fi
        ;;
esac
