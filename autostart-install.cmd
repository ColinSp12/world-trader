@echo off
setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "HERE=%~dp0"
(
  echo @echo off
  echo start "world-trader" /min "C:\Users\colin\tools\node\node.exe" "%HERE%server.mjs"
) > "%STARTUP%\world-trader-autostart.cmd"
echo Installed: World Trader will start minimized at every login.
echo Dashboard: http://localhost:3555
echo To remove, run autostart-remove.cmd
pause
