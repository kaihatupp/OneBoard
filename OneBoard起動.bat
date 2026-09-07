@echo off
setlocal
title OneBoard server
cd /d "%~dp0"
set PORT=8123
set "URL=http://localhost:%PORT%/"

echo.
echo   OneBoard  -  %URL%
echo   Closing the OneBoard window stops this server automatically.
echo   (You can also just close this window.)
echo.

rem --- Locate the Chrome executable ---
set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if not defined CHROME if exist "%%~P" set "CHROME=%%~P"
if not defined CHROME for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| findstr /i "REG_SZ"') do set "CHROME=%%B"
if not defined CHROME for /f "tokens=2,*" %%A in ('reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| findstr /i "REG_SZ"') do set "CHROME=%%B"

where py >nul 2>nul
if %errorlevel%==0 (
  call :openbrowser
  py server.py %PORT%
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  call :openbrowser
  python server.py %PORT%
  goto :eof
)

echo Python was not found on this PC.
echo Install Python from https://www.python.org/ and run this file again,
echo or open index.html directly in your browser.
pause
goto :eof

:openbrowser
if defined CHROME (
  rem Always open a brand-new Chrome window
  start "" "%CHROME%" --new-window "%URL%"
) else (
  echo Chrome was not found - opening in the default browser instead.
  start "" "%URL%"
)
goto :eof
