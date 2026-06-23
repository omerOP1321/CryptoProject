@echo off
REM Internal helper: launched by Windows Task Scheduler to run the engine
REM in the background (no visible window). Do not run this directly to test --
REM use run_engine.bat for an interactive run.
cd /d "%~dp0\.."
set "PROJ=%cd%"

set "PY="
if exist "%PROJ%\.venv312\Scripts\pythonw.exe" set "PY=%PROJ%\.venv312\Scripts\pythonw.exe"
if not defined PY if exist "%PROJ%\.venv\Scripts\pythonw.exe" set "PY=%PROJ%\.venv\Scripts\pythonw.exe"
if not defined PY exit /b 1

if not exist "%PROJ%\logs" mkdir "%PROJ%\logs"
set PYTHONUNBUFFERED=1
"%PY%" "%PROJ%\inference_orchestrator.py" >> "%PROJ%\logs\service.log" 2>&1
