@echo off
setlocal
title OneBoard DEV server
cd /d "%~dp0"
set PORT=8123
set "URL=http://localhost:%PORT%/"
set "DEVPROFILE=%~dp0.dev-profile"

echo.
echo   OneBoard  [ DEV ]  -  %URL%
echo   Opens Chrome with a SEPARATE profile (%DEVPROFILE%),
echo   so this window's localStorage is isolated from your real OneBoard data.
echo   First run has no data - paste dev-seed.js in DevTools console to load dummy data.
echo   Closing the OneBoard window stops this server automatically.
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
echo Install Python from https://www.python.org/ and run this file again.
pause
goto :eof

:openbrowser
if defined CHROME (
  rem Separate user-data-dir = fully isolated browser profile / localStorage
  start "" "%CHROME%" --new-window --user-data-dir="%DEVPROFILE%" --no-first-run --no-default-browser-check "%URL%"
) else (
  echo Chrome was not found. The DEV profile needs Chrome - please install it.
  echo Opening in the default browser instead (NOT isolated from real data).
  start "" "%URL%"
)
goto :eof
