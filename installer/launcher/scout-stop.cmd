@echo off
rem ---------------------------------------------------------------------------------------------
rem  Stop the SCOUT host that scout-host.cmd started.
rem
rem  The host writes its own process id to scout.pid, so this stops that one process and its
rem  children - never every node.exe on the machine. Use it when the host console is not in front
rem  of you (a second monitor, or a remote session).
rem ---------------------------------------------------------------------------------------------
setlocal enableextensions
set "SCOUT_DATA=%~dp0"

if not exist "%SCOUT_DATA%scout.pid" (
  echo The SCOUT host does not look like it is running - no scout.pid in "%SCOUT_DATA%".
  echo If a host console window is open, close it or press Ctrl+C there.
  pause
  exit /b 0
)

set /p SCOUT_PID=<"%SCOUT_DATA%scout.pid"
if "%SCOUT_PID%"=="" (
  echo scout.pid is empty - nothing to stop.
  pause
  exit /b 0
)

echo Stopping SCOUT host (process %SCOUT_PID%)...
taskkill /PID %SCOUT_PID% /T /F
if errorlevel 1 (
  echo Windows could not stop process %SCOUT_PID% - it has probably already exited.
) else (
  echo Stopped. This window closes itself.
)
del "%SCOUT_DATA%scout.pid" >nul 2>&1
timeout /t 3 >nul
exit /b 0
