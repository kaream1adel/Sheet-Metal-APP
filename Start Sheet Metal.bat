@echo off
title Sheet Metal
cd /d "%~dp0"

rem The install folder: data\, node\, cloudflared.exe and versions\ live next to this file.
set "SHEETMETAL_HOME=%~dp0"
if not defined PORT set PORT=4300
if not defined OPEN set OPEN=1

rem 1) Node bundled with the app (normal case)  2) Node installed on this PC
set "NODE=%~dp0node\node.exe"
if exist "%NODE%" goto :run
set "NODE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE=node"
if defined NODE goto :run
echo.
echo  Node.js was not found. Put node.exe in the "node" folder next to this file.
echo.
pause
exit /b 1

:run
rem Which code runs: current.txt names a folder in versions\ ("." = the code next to this file).
set "CUR=."
if exist "%~dp0current.txt" set /p CUR=<"%~dp0current.txt"
set "APPDIR=%~dp0"
if not "%CUR%"=="." set "APPDIR=%~dp0versions\%CUR%\"
if not exist "%APPDIR%src\server.js" set "APPDIR=%~dp0"

if not exist "%APPDIR%node_modules\express\package.json" (
  echo.
  echo  The app files are incomplete: node_modules is missing.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%APPDIR%src\server.js"
set CODE=%errorlevel%
rem 42 = restart after an update or a rollback (and don't open another browser tab).
set OPEN=0
if %CODE%==42 goto :run
if %CODE%==0 goto :eof

rem A fresh update that failed to start: go back to the previous version by itself.
if exist "%~dp0update-trial.txt" if exist "%~dp0previous.txt" (
  echo.
  echo  The new version did not start. Going back to the previous version...
  echo.
  copy /y "%~dp0previous.txt" "%~dp0current.txt" >nul
  del "%~dp0update-trial.txt"
  goto :run
)
pause
