@echo off
REM Double-click to start MOLEFIELD from source (needs Python 3.10+ on PATH).
REM Pass arguments as needed (e.g. run_windows.bat --simulate)
python molefield.py %*
if errorlevel 1 pause
