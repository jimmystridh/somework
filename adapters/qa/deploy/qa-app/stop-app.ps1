# Stops exactly what start-app.ps1 started, by flag files that the two task scripts watch. Waits until both ports are closed.
[CmdletBinding()]
param([int]$TimeoutSeconds = 60)
$ctl = 'C:\somework\qa-app\control'
$webPort = 4499
if (Test-Path "$ctl\web-port.txt") { $webPort = [int](Get-Content "$ctl\web-port.txt" -TotalCount 1) }
function Test-Listening([int]$Port) { return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0 }
function Test-TaskRunning([string]$Name) { return @(& schtasks.exe /Query /TN $Name /FO LIST 2>$null | Select-String -Pattern 'Status:\s+Running').Count -gt 0 }
# the flags are set whenever a launcher is running, not only when its port is open: a launcher whose application never came up would otherwise stay
if ((Test-Listening $webPort) -or (Test-TaskRunning 'QaAppWeb')) { Set-Content "$ctl\stop-web" 'stop' }
if ((Test-Listening 8080) -or (Test-TaskRunning 'QaAppServer')) { Set-Content "$ctl\stop-server" 'stop' }
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (((Test-Listening $webPort) -or (Test-Listening 8080) -or (Test-TaskRunning 'QaAppWeb') -or (Test-TaskRunning 'QaAppServer')) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
foreach ($name in 'QaAppWeb', 'QaAppServer') { if (Test-TaskRunning $name) { & schtasks.exe /End /TN $name | Out-Null } }
if ((Test-Listening $webPort) -or (Test-Listening 8080)) { Write-Host 'FAIL: something still listens (see C:\somework\qa-app\logs)'; exit 1 }
Write-Host 'STOPPED'
