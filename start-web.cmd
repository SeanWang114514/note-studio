@echo off
cd /d "%~dp0"
node tools\start-stirling.mjs
node node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5199
pause
