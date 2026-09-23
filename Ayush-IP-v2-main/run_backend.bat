@echo off
title IP-SAKTI Sahayak - Backend (Port 8000)
echo ===================================================
echo Starting IP-SAKTI Sahayak Statutory RAG Backend Server
echo ===================================================

cd /d "%~dp0"

netstat -ano | findstr ":8000" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [OK] Backend is ALREADY RUNNING on http://127.0.0.1:8000
    echo Health endpoint: http://127.0.0.1:8000/api/health
    pause
    exit /b 0
)

set PYTHON_CMD=python
if exist ".venv\Scripts\python.exe" (
    set PYTHON_CMD=".venv\Scripts\python.exe"
)

echo Starting FastAPI server on http://127.0.0.1:8000 ...
%PYTHON_CMD% backend\main.py

pause
