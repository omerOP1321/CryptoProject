#!/bin/bash
# ===========================================================================
# Crypto AI inference engine launcher — macOS
#   - Double-click in Finder, OR run "./run_engine.command" in a Terminal.
#   - On FIRST run it creates a Python virtual environment and installs the
#     dependencies automatically (one-time, takes a few minutes).
#   - Runs in the FOREGROUND so you see live output; Ctrl+C stops it.
#   - All output is shown on screen AND saved to logs/engine_<date>.log
#
# NOTE: the engine pushes predictions to Supabase, which is what the website
# reads. The site only updates while this is running. For always-on 24/7,
# use service/install_service_mac.command instead.
# ===========================================================================
set -uo pipefail

cd "$(dirname "$0")/.." || { echo "Cannot find project folder."; read -r; exit 1; }

# --- locate (or create) the Python interpreter ------------------------------
if   [ -x ".venv312/bin/python" ]; then PY=".venv312/bin/python"
elif [ -x ".venv/bin/python" ];    then PY=".venv/bin/python"
else
    echo "No virtual environment found. Setting one up (first-time only)..."
    PYBOOT="$(command -v python3 || command -v python || true)"
    if [ -z "$PYBOOT" ]; then
        echo "ERROR: Python 3 is not installed. Get it from https://www.python.org/downloads/"
        read -r; exit 1
    fi
    "$PYBOOT" -m venv .venv || { echo "Failed to create virtual environment."; read -r; exit 1; }
    PY=".venv/bin/python"
    "$PY" -m pip install --upgrade pip
    "$PY" -m pip install -r requirements.txt || { echo "Failed to install dependencies."; read -r; exit 1; }
    echo "Setup complete."
fi

# --- run --------------------------------------------------------------------
mkdir -p logs
LOG="logs/engine_$(date +%Y%m%d_%H%M%S).log"
echo "========================================"
echo " Starting Crypto AI inference engine"
echo " Log file : $LOG"
echo " Stop with: Ctrl+C"
echo "========================================"
echo

PYTHONUNBUFFERED=1 "$PY" serving/inference_orchestrator.py 2>&1 | tee -a "$LOG"
