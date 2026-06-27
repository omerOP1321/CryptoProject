#!/bin/bash
# ===========================================================================
# Crypto AI auth API launcher — macOS
#   - Double-click in Finder, OR run "./run_auth.command" in a Terminal.
#   - On FIRST run it installs Node dependencies and initializes the SQLite
#     database (creates the admin account) automatically — one-time.
#   - Runs in the FOREGROUND so you see live output; Ctrl+C stops it.
#
# This API powers login / registration and the admin-editable About page.
# It is used by a LOCAL copy of the website (http://localhost:8765). The live
# Vercel site needs the API deployed separately to use these features.
# ===========================================================================
set -uo pipefail

cd "$(dirname "$0")" || { echo "Cannot find server folder."; read -r; exit 1; }

# --- locate Node ------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js is not installed. Get it from https://nodejs.org/ (LTS)."
    read -r; exit 1
fi

# --- install dependencies (first run only) ----------------------------------
if [ ! -d node_modules ]; then
    echo "Installing dependencies (first-time only)..."
    npm install || { echo "npm install failed."; read -r; exit 1; }
fi

# --- initialize database + seed admin (first run only) ----------------------
if [ ! -f data/app.db ]; then
    echo "Initializing database (first-time only)..."
    npm run migrate || { echo "Database setup failed."; read -r; exit 1; }
fi

echo "========================================"
echo " Starting auth API"
echo " URL      : http://localhost:4000"
echo " Stop with: Ctrl+C"
echo "========================================"
echo

npm start
