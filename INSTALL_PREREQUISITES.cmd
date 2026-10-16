@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Install-Prerequisites.ps1"
set "HF_RESULT=%ERRORLEVEL%"
pause
exit /b %HF_RESULT%
