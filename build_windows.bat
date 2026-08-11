@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM  Build MOLEFIELD.exe — one self-contained file, no Python on the target PC
REM  Run this from the project root on a Windows machine with Python 3.10+
REM ───────────────────────────────────────────────────────────────────────────

echo.
echo   MOLEFIELD Windows Build
echo   -----------------------

where python >nul 2>nul
if errorlevel 1 (
  echo   Python is not on PATH. Install it from python.org and tick
  echo   "Add Python to PATH" during setup, then run this again.
  pause
  exit /b 1
)

echo   Installing PyInstaller...
python -m pip install --quiet --upgrade pyinstaller
if errorlevel 1 (
  echo   pip failed. Check your internet connection.
  pause
  exit /b 1
)

echo   Building standalone executable...
python -m PyInstaller --noconfirm --onefile --console ^
  --name MOLEFIELD ^
  --add-data "game;game" ^
  --add-data "bridge;bridge" ^
  molefield.py
if errorlevel 1 (
  echo   Build failed. Read the error above.
  pause
  exit /b 1
)

echo.
echo   Done: dist\MOLEFIELD.exe
echo.
echo   Double-clicking MOLEFIELD.exe starts the bridge and opens the game.
echo.
pause
