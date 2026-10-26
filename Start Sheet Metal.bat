@echo off
title Sheet Metal
cd /d "%~dp0"

if not defined PORT set PORT=4300

if not exist "%~dp0node_modules\express\package.json" (
  echo.
  echo  node_modules not found. Run "npm install" first.
  echo.
  pause & exit /b 1
)

rem Prefer the bundled Node (added in a later step), else an installed one.
if exist "%~dp0node\node.exe" (
  "%~dp0node\node.exe" src\server.js
  goto :end
)
where node >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:%PORT%"
  node src\server.js
  goto :end
)
echo.
echo  Node.js was not found.
echo.
pause
:end
