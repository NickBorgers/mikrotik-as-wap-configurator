#!/bin/bash

# MikroTik Device Configuration Script
# This script waits for the device and applies configuration

set -e

echo "========================================="
echo "MikroTik Device Configuration Helper"
echo "========================================="
echo ""

# Check if password provided
if [ -z "$1" ]; then
    echo "Usage: ./configure-device.sh <device-password> [config-file]"
    echo ""
    echo "Example:"
    echo "  ./configure-device.sh DQ45LVEQRZ"
    echo "  ./configure-device.sh DQ45LVEQRZ custom-config.yaml"
    echo ""
    exit 1
fi

PASSWORD=$1
CONFIG_FILE=${2:-config.yaml}

echo "Password: $PASSWORD"
echo "Config file: $CONFIG_FILE"
echo ""

# Update config.yaml with the password
echo "Updating $CONFIG_FILE with password..."
sed -i "s/password: .*/password: $PASSWORD/" $CONFIG_FILE
echo "✓ Config file updated"
echo ""

# Wait for device to be ready
echo "Waiting for device to be accessible..."
node wait-for-device.js $PASSWORD

# Apply configuration
echo "Applying configuration from $CONFIG_FILE..."
echo ""
node apply-config.js $CONFIG_FILE

echo ""
echo "========================================="
echo "Configuration process complete!"
echo "========================================="
