@echo off
setlocal
title SEO Studio Launcher

cd /d "%~dp0"

set PORT=4318
set URL=http://localhost:%PORT%

echo SEO Studio
echo Project dir: %cd%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js LTS first:
  echo https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing npm dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

if not exist dist\index.html (
  echo Building frontend...
  call npm run build
  if errorlevel 1 goto :fail
)

for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr :%PORT%') do (
  echo Stopping old process on port %PORT% ...
  taskkill /PID %%p /F >nul 2>nul
)

echo.
echo Starting local service...
start "SEO Studio Server" cmd /k "cd /d ""%cd%"" && npm start"

timeout /t 4 /nobreak >nul
start "" %URL%

echo.
echo Browser URL: %URL%
echo Keep the "SEO Studio Server" window open.
echo If DOCX export is needed on Windows, install Python 3 manually.
echo.
pause
exit /b 0

:fail
echo.
echo Startup failed. Check the messages above.
echo.
pause
exit /b 1
