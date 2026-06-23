#!/bin/bash
# ===========================================================================
# Install the Crypto AI engine as an always-on background service (macOS).
#   - Runs in the background (no Terminal window needed).
#   - Auto-starts when you log in, and auto-restarts if it crashes.
#   - Keeps the website updating 24/7.
# Double-click this file to install. Use uninstall_service_mac.command to stop.
# ===========================================================================
set -uo pipefail

cd "$(dirname "$0")/.." || { echo "Cannot find project folder."; read -r; exit 1; }
PROJ="$(pwd)"
LABEL="com.cryptoproject.engine"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Find the venv python (must exist already — run run_engine.command once first)
if   [ -x "$PROJ/.venv312/bin/python" ]; then PY="$PROJ/.venv312/bin/python"
elif [ -x "$PROJ/.venv/bin/python" ];    then PY="$PROJ/.venv/bin/python"
else
    echo "No virtual environment found."
    echo "Please double-click run_engine.command once first (it sets things up), then try again."
    read -r; exit 1
fi

mkdir -p "$PROJ/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PY</string>
        <string>$PROJ/inference_orchestrator.py</string>
    </array>
    <key>WorkingDirectory</key><string>$PROJ</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$PROJ/logs/service.log</string>
    <key>StandardErrorPath</key><string>$PROJ/logs/service.log</string>
    <key>EnvironmentVariables</key>
    <dict><key>PYTHONUNBUFFERED</key><string>1</string></dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Service installed and started."
echo "  - It runs in the background and auto-starts every time you log in."
echo "  - Logs: $PROJ/logs/service.log"
echo "  - To stop it, double-click uninstall_service_mac.command"
read -r
