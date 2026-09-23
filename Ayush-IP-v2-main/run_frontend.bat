@echo off
title IP-SAKTI Sahayak - Frontend (Port 3000)
echo ===================================================
echo Starting IP-SAKTI Sahayak Frontend Web Application
echo ===================================================

cd /d "%~dp0"

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [OK] Frontend is ALREADY RUNNING on http://localhost:3000
    pause
    exit /b 0
)

if not exist "node_modules\" (
    echo node_modules not found. Installing dependencies...
    call npm.cmd install
)

echo Starting Vite / Express dev server on http://localhost:3000 ...
call npm.cmd run dev

pause
