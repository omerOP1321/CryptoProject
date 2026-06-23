@echo off
REM ===========================================================================
REM Crypto AI inference engine launcher - Windows
REM   - Double-click in File Explorer, OR run "run_engine.bat" in a terminal.
REM   - On FIRST run it creates a Python virtual environment and installs the
REM     dependencies automatically (one-time, takes a few minutes).
REM   - Runs in the FOREGROUND so you see live output; Ctrl+C stops it.
REM   - All output is shown on screen AND saved to logs\engine_<date>.log
REM
REM NOTE: the engine pushes predictions to Supabase, which is what the website
REM reads. The site only updates while this is running. For always-on 24/7,
REM use service\install_service_windows.bat instead.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM --- locate (or create) the Python interpreter ----------------------------
set "PY="
if exist ".venv312\Scripts\python.exe" set "PY=.venv312\Scripts\python.exe"
if not defined PY if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

if not defined PY (
    echo No virtual environment found. Setting one up ^(first-time only^)...
    set "PYBOOT="
    where py    >nul 2>&1 && set "PYBOOT=py"
    if not defined PYBOOT where python >nul 2>&1 && set "PYBOOT=python"
    if not defined PYBOOT (
        echo ERROR: Python is not installed. Get it from https://www.python.org/downloads/
        pause & exit /b 1
    )
    !PYBOOT! -m venv .venv || ( echo Failed to create virtual environment. & pause & exit /b 1 )
    set "PY=.venv\Scripts\python.exe"
    "!PY!" -m pip install --upgrade pip
    "!PY!" -m pip install -r requirements.txt || ( echo Failed to install dependencies. & pause & exit /b 1 )
    echo Setup complete.
)

REM --- run ------------------------------------------------------------------
if not exist logs mkdir logs
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set "DT=%%I"
set "LOG=logs\engine_%DT:~0,8%_%DT:~8,6%.log"

echo ========================================
echo  Starting Crypto AI inference engine
echo  Log file : %LOG%
echo  Stop with: Ctrl+C
echo ========================================
echo.

set PYTHONUNBUFFERED=1
"%PY%" inference_orchestrator.py 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%LOG%'"
pause
