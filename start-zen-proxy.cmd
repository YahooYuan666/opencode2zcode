@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem --- ZCode data directory ------------------------------------------------
rem ZCODE_DATA_BASE_DIR is NOT a persistent Windows variable. ZCode only
rem injects it into its own child processes, so a double-click from Explorer
rem does not have it. Without it the provider config lands in the wrong
rem directory and ZCode never shows the model group.
rem
rem zen-proxy.mjs detects the real data directory itself and records it in
rem zcode-data-dir.txt next to this script; we read that here as a fast path.
rem Detection alone is enough, the file is just a shortcut.
if defined ZCODE_DATA_BASE_DIR goto :datadir_ready
if not exist "%~dp0zcode-data-dir.txt" goto :datadir_ready
set /p ZCODE_DATA_BASE_DIR=<"%~dp0zcode-data-dir.txt"
:datadir_ready
rem If detection ever fails, set the path by hand on the next line and
rem remove the "rem " prefix:
rem set "ZCODE_DATA_BASE_DIR=D:\Program"
rem -------------------------------------------------------------------------

where node >nul 2>nul || goto :nonode
echo opencode2zcode - starting loopback proxy (foreground, for debugging)
echo.
echo   This window must stay open; closing it stops the proxy.
echo   For normal use, run install-autostart.cmd once instead - ZCode then
echo   starts the proxy silently and you never see a window again.
echo.
echo Default port 41930. Health check: curl http://127.0.0.1:41930/healthz
echo Run with --help to see all options.
echo.
node "%~dp0zen-proxy.mjs" %*
echo.
echo Proxy exited.
pause
exit /b 0

:nonode
echo Node.js 18+ was not found in PATH. Please install Node.js first.
pause
exit /b 1
