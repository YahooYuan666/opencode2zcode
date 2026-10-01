@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Full removal, in two independent steps so neither can strand the other:
rem   1. drop the SessionStart hook from ZCode's CLI config
rem   2. drop this tool's two providers from ZCode's personal provider config
rem Your other providers and other hooks are left untouched.

where node >nul 2>nul || goto :nonode
echo opencode2zcode - uninstalling
echo.

node "%~dp0install.mjs" --uninstall
if errorlevel 1 goto :failed

node "%~dp0zen-proxy.mjs" --remove-provider
if errorlevel 1 goto :failed

echo.
echo Uninstalled. ZCode is back to how it was before opencode2zcode.
echo (If a proxy is still running in the background, close that process once.)
pause
exit /b 0

:failed
echo.
echo Uninstall did not finish cleanly. See the messages above.
pause
exit /b 1

:nonode
echo Node.js 18+ was not found in PATH. Please install Node.js first.
pause
exit /b 1
