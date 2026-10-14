@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
if errorlevel 1 (
  echo Operation failed. Please read the error above.
  pause
  exit /b 1
)
pause
