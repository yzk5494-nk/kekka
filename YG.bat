@echo off
cd /d "%~dp0"
echo サーバーを再起動しています...
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul
start "" /min cmd /c "node wp-poster.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/yg-poster"
