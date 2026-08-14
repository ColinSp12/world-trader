@echo off
cd /d "%~dp0"
echo Starting World Trader (paper trading) on http://localhost:3555 ...
start "" http://localhost:3555/trades
:loop
"C:\Users\colin\tools\node\node.exe" server.mjs
echo.
echo server exited (code %errorlevel%) - restarting in 5 seconds... press Ctrl+C to stop
timeout /t 5 /nobreak >nul
goto loop
