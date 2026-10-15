@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage.ps1" -Action Start
set "MARKSIX_EXIT=%ERRORLEVEL%"
if not "%MARKSIX_EXIT%"=="0" echo Operation failed. Read the message above.
if not "%MARKSIX_NO_PAUSE%"=="1" pause
exit /b %MARKSIX_EXIT%
