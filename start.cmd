@echo off
cd /d "%~dp0"
echo Starting World Trader (paper trading) on http://localhost:3555 ...
start "" http://localhost:3555
"C:\Users\colin\tools\node\node.exe" server.mjs
