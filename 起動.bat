@echo off
cd /d "%~dp0"

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 (
  echo Server is already running. Opening browser...
  start "" "http://localhost:3000"
  pause
  goto end
)

echo Starting server...
echo Open http://localhost:3000 in your browser.
echo Do not close this window.
echo.
start /b "" cmd /c "timeout /t 2 >nul && start http://localhost:3000"
node wp-poster.js

if %errorlevel% neq 0 (
  echo.
  echo Error occurred. Check the message above.
  pause
  goto end
)

echo.
echo Server stopped.

:end
pause
