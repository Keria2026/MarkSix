@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage.ps1" -Action Install
if errorlevel 1 echo Operation failed. Read the message above.
pause
