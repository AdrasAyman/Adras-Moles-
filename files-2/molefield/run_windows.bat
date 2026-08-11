@echo off
REM Double-click to start MOLEFIELD from source (needs Python 3.10+ on PATH).
REM No hardware yet? Change the line below to add --simulate
python molefield.py %*
if errorlevel 1 pause
