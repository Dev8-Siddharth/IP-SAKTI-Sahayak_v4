@echo off
title IP-SAKTI Sahayak - System Launcher
echo ========================================================
echo Launching IP-SAKTI Sahayak Full System (Backend & Frontend)
echo ========================================================

cd /d "%~dp0"

set PYTHON_CMD=python
if exist ".venv\Scripts\python.exe" (
    set PYTHON_CMD=".venv\Scripts\python.exe"
)

netstat -ano | findstr ":8000" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [OK] Backend is already running on port 8000.
) else (
    echo 1. Launching Python FastAPI RAG Backend on port 8000...
    start "IP-SAKTI Sahayak Backend (Port 8000)" cmd /k "cd /d "%~dp0" && %PYTHON_CMD% backend\main.py"
    echo Waiting for backend initialization...
    timeout /t 3 /nobreak >nul 2>nul || ping 127.0.0.1 -n 4 >nul
)

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [OK] Frontend is already running on port 3000.
) else (
    echo 2. Launching Frontend Web Server on port 3000...
    start "IP-SAKTI Sahayak Frontend (Port 3000)" cmd /k "cd /d "%~dp0" && npm.cmd run dev"
)

echo.
echo ========================================================
echo Both services are initialized!
echo Frontend: http://localhost:3000
echo Backend : http://127.0.0.1:8000/api/health
echo ========================================================
echo.
pause
