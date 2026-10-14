@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage.ps1" -Action Backup
if errorlevel 1 (
  echo Operation failed. Please read the error above.
  pause
  exit /b 1
)
pause
