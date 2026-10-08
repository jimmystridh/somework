@echo off
rem Entry point of the repository-managed product build (build-adm.ps1): the script runs with the process-local RemoteSigned policy the machine needs for local scripts.
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0build-adm.ps1" %*
exit /b %ERRORLEVEL%
