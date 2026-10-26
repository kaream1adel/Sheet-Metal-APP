@echo off
title Sheet Metal
cd /d "%~dp0"

if not defined PORT set PORT=4300
if not defined OPEN set OPEN=1

if not exist "%~dp0node_modules\express\package.json" (
  echo.
  echo  The app files are incomplete: node_modules is missing.
  echo.
  pause & exit /b 1
)

rem 1) Node bundled with the app (normal case)
if exist "%~dp0node\node.exe" (
  "%~dp0node\node.exe" src\server.js
  goto :end
)
rem 2) Node installed on this PC
where node >nul 2>nul
if %errorlevel%==0 (
  node src\server.js
  goto :end
)
echo.
echo  Node.js was not found. Put node.exe in the "node" folder next to this file.
echo.
pause
:end
if errorlevel 1 pause
