@echo off
rem ---------------------------------------------------------------------------------------------
rem  SCOUT host launcher - installed and updated by SCOUT-Setup.exe, not meant to be edited.
rem
rem  Everything it needs sits next to it in the data directory (%APPDATA%\SCOUT):
rem    app-root.txt    where the program files are (written by the installer)
rem    port.txt        the port the host listens on (written by the installer)
rem    gsi_token.txt   the token CS2 pushes with  (written by the installer)
rem    panel_token.txt remote-control token, only when remote access is on
rem    remote.txt      "on" or "off"
rem
rem  The working directory is the data directory: the host keeps config/, public/uploads/ and
rem  recordings/ here, never in the program files, so an update cannot touch operator data.
rem ---------------------------------------------------------------------------------------------
setlocal enableextensions
title SCOUT host

set "SCOUT_DATA=%~dp0"

if not exist "%SCOUT_DATA%app-root.txt" goto :broken
set /p SCOUT_APP_ROOT=<"%SCOUT_DATA%app-root.txt"
if not exist "%SCOUT_APP_ROOT%\runtime\node.exe" goto :broken
if not exist "%SCOUT_APP_ROOT%\host\server\index.js" goto :broken

set "PORT=8080"
if exist "%SCOUT_DATA%port.txt" set /p PORT=<"%SCOUT_DATA%port.txt"
if exist "%SCOUT_DATA%gsi_token.txt" set /p GSI_TOKEN=<"%SCOUT_DATA%gsi_token.txt"
if exist "%SCOUT_DATA%panel_token.txt" set /p SCOUT_PANEL_TOKEN=<"%SCOUT_DATA%panel_token.txt"
if exist "%SCOUT_DATA%remote.txt" set /p SCOUT_REMOTE=<"%SCOUT_DATA%remote.txt"

set "NODE_ENV=production"
set "SCOUT_PID_FILE=%SCOUT_DATA%scout.pid"
cd /d "%SCOUT_DATA%"

echo.
echo   SCOUT host - control panel: http://127.0.0.1:%PORT%/admin
echo   OBS browser source:         http://127.0.0.1:%PORT%/obs
echo   Press Ctrl+C to stop. (If Windows asks about terminating the batch job, answer Y.)
echo.

"%SCOUT_APP_ROOT%\runtime\node.exe" "%SCOUT_APP_ROOT%\host\server\index.js"
set "SCOUT_EXIT=%ERRORLEVEL%"

echo.
if not "%SCOUT_EXIT%"=="0" echo   SCOUT host stopped with exit code %SCOUT_EXIT%. The messages above say why.
if not "%SCOUT_EXIT%"=="0" pause
exit /b %SCOUT_EXIT%

:broken
echo.
echo   SCOUT cannot start: the installation looks incomplete.
echo   Expected %SCOUT_APP_ROOT%\host\server\index.js and %SCOUT_APP_ROOT%\runtime\node.exe
echo   Run SCOUT-Setup.exe again - it repairs missing program files and keeps your data.
echo.
pause
exit /b 1
