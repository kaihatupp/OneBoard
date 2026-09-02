@echo off
setlocal
cd /d "%~dp0"
set PORT=8123

echo.
echo   OneBoard  -  http://localhost:%PORT%/
echo   Close this window to stop the local server.
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:%PORT%/"
  py -m http.server %PORT%
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:%PORT%/"
  python -m http.server %PORT%
  goto :eof
)

echo Python was not found on this PC.
echo Install Python from https://www.python.org/ and run this file again,
echo or open index.html directly in your browser.
pause
