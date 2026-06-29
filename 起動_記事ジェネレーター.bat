@echo off
cd /d "%~dp0"

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 (
  echo Server is already running. Opening article generator...
  start "" "http://localhost:3000/article-generator"
  pause
  goto end
)

echo Starting server...
echo Open http://localhost:3000/article-generator in your browser.
echo Do not close this window.
echo.
start /b "" cmd /c "timeout /t 2 >nul && start http://localhost:3000/article-generator"
node wp-poster.js

:end
pause
