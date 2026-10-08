@echo off
rem Entry point of the repository-managed product build (build-adm.ps1). The model-run environment has a minimal PATH, so PowerShell is called by its full path; the script runs with the process-local RemoteSigned policy the machine needs for local scripts.
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0build-adm.ps1" %*
exit /b %ERRORLEVEL%
