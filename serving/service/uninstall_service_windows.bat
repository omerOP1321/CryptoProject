@echo off
REM Stop and remove the Crypto AI background service (Windows).
REM Double-click this file to stop the always-on service.
schtasks /end    /tn "CryptoEngine" >nul 2>&1
schtasks /delete /tn "CryptoEngine" /f

echo Background service stopped and removed.
echo The website will stop receiving new predictions until you start the engine again.
pause
