@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0login-sync-local\install.ps1" %*
exit /b %errorlevel%
