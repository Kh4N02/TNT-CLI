@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install
  echo Installing Playwright Chrome ^(first run only^)...
  call npx playwright install chrome
)
node tnt_cmd.js %*
if errorlevel 1 (
  echo.
  echo TNT CLI exited with an error ^(see message above^).
  pause
)
