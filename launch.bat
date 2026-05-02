@echo off
title Atlantis-Visa
echo 🔱 Welcome to Atlantis-Visa
echo.
echo This will start Google Chrome with remote debugging.
echo Please log into TLScontact and navigate to the appointment page.
echo The bot will take over automatically.
echo.

:: Paths
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
set USER_DATA=%LOCALAPPDATA%\Google\Chrome\User Data

:: Start Chrome
echo Starting Chrome...
start "" %CHROME% --remote-debugging-port=9222 --user-data-dir="%USER_DATA%" --profile-directory="tls-work"
echo Chrome launched. Please log in now.
echo.

:: Wait for Chrome to be ready
timeout /t 5 /nobreak >nul

:: Start the bot
echo Starting soldier...
atlantis-visa.exe
pause