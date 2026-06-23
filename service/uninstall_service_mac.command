#!/bin/bash
# Stop and remove the Crypto AI background service (macOS).
# Double-click this file to stop the always-on service.
set -uo pipefail

LABEL="com.cryptoproject.engine"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "Background service stopped and removed."
echo "The website will stop receiving new predictions until you start the engine again."
read -r
