@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-SC-Event-Bridge.ps1" %*
exit /b %errorlevel%
