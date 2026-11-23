@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-SC-Relay.ps1" %*
exit /b %errorlevel%
