@echo off
title Stop Autonomous Job Engine
cd /d "%~dp0"

echo ==============================================================================
echo 🛑 STOPPING AUTONOMOUS JOB ENGINE
echo ==============================================================================
echo.

node main.js stop

echo.
echo Engine daemon stopped successfully.
pause
