@echo off
echo OfficeMesh Signaling Server
echo ============================
echo.

REM Install dependencies if needed
python -m pip show aiohttp >nul 2>&1
if errorlevel 1 (
    echo Installing Python dependencies...
    python -m pip install aiohttp python-socketio
    echo.
)

echo Starting server on http://localhost:5000
echo Press Ctrl+C to stop.
echo.
python server.py
pause
