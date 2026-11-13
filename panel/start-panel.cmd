@echo off
rem Don Robert Cafe Wi-Fi panel. Keeps running; restarts itself if it ever stops.
rem Put a shortcut to this file in shell:startup (see README).
title Don Robert Cafe Wi-Fi panel
cd /d "%~dp0"
:loop
node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src\server.ts
echo Panel stopped. Restarting in 5 seconds... (close this window to stop it)
timeout /t 5 /nobreak >nul
goto loop
