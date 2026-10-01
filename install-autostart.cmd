@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Install the "starts with ZCode, no black window" behavior.
rem Writes a SessionStart hook into ZCode's CLI config. After this you never
rem have to double-click anything again, and never see a console window.
rem See AI-SETUP.md / README.md for what exactly gets written.

where node >nul 2>nul || goto :nonode
echo opencode2zcode - installing autostart
echo.
node "%~dp0install.mjs" %*
if errorlevel 1 goto :failed
echo.
echo Done. ZCode will start the proxy silently from now on.
echo To undo: run uninstall.cmd
pause
exit /b 0

:failed
echo.
echo Install failed. See the messages above.
pause
exit /b 1

:nonode
echo Node.js 18+ was not found in PATH. Please install Node.js first.
pause
exit /b 1
