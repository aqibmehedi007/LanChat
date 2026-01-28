@echo off
REM OfficeMesh Signaling Server - Build Script
REM This script creates a standalone .exe using PyInstaller

echo ============================================
echo  OfficeMesh Signaling Server - Build Script
echo ============================================
echo.

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.10+ from https://python.org
    pause
    exit /b 1
)

REM Check if we're in the right directory
if not exist "server.py" (
    echo ERROR: server.py not found in current directory
    echo Please run this script from the plan\server folder
    pause
    exit /b 1
)

echo [1/3] Installing dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/3] Building executable with PyInstaller...
pyinstaller ^
    --onefile ^
    --name "OfficeMesh-Signaling" ^
    --icon "../extension/icons/icon128.png" ^
    --add-data "../../README.md;." ^
    --console ^
    --clean ^
    server.py

if errorlevel 1 (
    echo ERROR: PyInstaller build failed
    pause
    exit /b 1
)

echo.
echo [3/3] Build complete!
echo.
echo Executable created at: dist\OfficeMesh-Signaling.exe
echo.
echo To run the signaling server:
echo   1. Double-click OfficeMesh-Signaling.exe
echo   2. Or run from command line: dist\OfficeMesh-Signaling.exe
echo.
echo The server will listen on port 5000.
echo Your device ID and name are stored in: %%USERPROFILE%%\.officemesh\device.json
echo.

pause
