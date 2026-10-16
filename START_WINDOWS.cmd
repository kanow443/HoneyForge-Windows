@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\HoneyForge.ps1" -Action Setup
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\HoneyForge.ps1" %*
)
set "HF_RESULT=%ERRORLEVEL%"
if not "%HF_RESULT%"=="0" echo HoneyForge failed. Read the error above and README_WINDOWS.md.
pause
exit /b %HF_RESULT%
