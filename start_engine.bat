@echo off
title Autonomous Job Engine (Running)
cd /d "%~dp0"

echo ==============================================================================
echo 🤖 STARTING AUTONOMOUS JOB ENGINE (INTERVAL MODE)
echo ==============================================================================
echo.
echo Active Engines:
echo  1. Naukri (Profile Refresh + Job Applications)
echo  2. Wellfound (AngelList Jobs Auto-Apply)
echo  3. Y Combinator (Work at a Startup Auto-Apply)
echo  4. Remote & Startup Portals (Startup.jobs, RemoteOK, WWR, Himalayas)
echo.
echo Mode: LIVE (Real applications submitted)
echo Interval: Every 60 minutes continuously while laptop is on.
echo Daily Reports & Alerts sent to your email.
echo.
echo The exact wall-clock time for the NEXT EVENT TRIGGER will display below after each cycle.
echo.
echo To stop the engine at any time, double-click: stop_engine.bat
echo ==============================================================================
echo.

node main.js daemon --live --interval=60
