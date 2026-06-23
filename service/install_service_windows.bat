@echo off
REM ===========================================================================
REM Install the Crypto AI engine as an always-on background service (Windows).
REM   - Runs in the background (no window).
REM   - Auto-starts when you log in, and restarts if it stops.
REM   - Keeps the website updating 24/7.
REM Double-click this file to install. Use uninstall_service_windows.bat to stop.
REM ===========================================================================
setlocal
set "HERE=%~dp0"
cd /d "%HERE%.."
set "PROJ=%cd%"

REM Require the venv to exist already (run run_engine.bat once first).
if not exist "%PROJ%\.venv312\Scripts\pythonw.exe" if not exist "%PROJ%\.venv\Scripts\pythonw.exe" (
    echo No virtual environment found.
    echo Please double-click run_engine.bat once first ^(it sets things up^), then try again.
    pause & exit /b 1
)

schtasks /create /tn "CryptoEngine" /sc onlogon /rl highest /f /tr "\"%HERE%run_background.bat\""
if errorlevel 1 ( echo Failed to create the scheduled task. & pause & exit /b 1 )

echo Service installed.
echo   - It starts automatically every time you log in, in the background.
echo   - Logs: %PROJ%\logs\service.log
echo   - To start it right now without logging off, run:  schtasks /run /tn "CryptoEngine"
echo   - To stop it, double-click uninstall_service_windows.bat
schtasks /run /tn "CryptoEngine" >nul 2>&1
pause
