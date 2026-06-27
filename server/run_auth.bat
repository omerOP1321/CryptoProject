@echo off
REM ===========================================================================
REM Crypto AI auth API launcher - Windows
REM   - Double-click in Explorer, OR run "run_auth.bat" in a terminal.
REM   - On FIRST run it installs Node dependencies and initializes the SQLite
REM     database (creates the admin account) automatically - one-time.
REM   - Runs in the FOREGROUND; close the window or Ctrl+C to stop.
REM
REM This API powers login / registration and the admin-editable About page.
REM It is used by a LOCAL copy of the website (http://localhost:8765).
REM ===========================================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js is not installed. Get it from https://nodejs.org/ ^(LTS^).
    pause & exit /b 1
)

if not exist node_modules (
    echo Installing dependencies ^(first-time only^)...
    call npm install || ( pause & exit /b 1 )
)

if not exist data\app.db (
    echo Initializing database ^(first-time only^)...
    call npm run migrate || ( pause & exit /b 1 )
)

echo ========================================
echo  Starting auth API
echo  URL      : http://localhost:4000
echo  Stop with: Ctrl+C
echo ========================================
echo.

call npm start
