@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Full removal: drops the SessionStart hook AND this tool's two providers.
rem Your other providers and other hooks are left untouched.
rem Equivalent to: node zen-proxy.mjs --uninstall

where node >nul 2>nul || goto :nonode
echo opencode2zcode - uninstalling
echo.
node "%~dp0zen-proxy.mjs" --uninstall %*
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
echo Node.js 18+ was not found in PATH.
echo If you got the single-file opencode2zcode.exe instead, run that directly -
echo it needs no Node.js at all:  opencode2zcode.exe --uninstall
pause
exit /b 1
