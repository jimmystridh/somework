# Starts the local test stack (back-end server + web app) and waits until both answer. Idempotent. Safe to call from the QA agent's account:
# it only writes three small files in control\ and asks Task Scheduler to run the two prepared tasks (it cannot change what they run).
#   start-app.ps1 -WebRoot C:\somework\qa-app\workspaces\<job>\Source\admin.web [-WebPort 4499] [-TenantMode single|multi]
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WebRoot,
    [ValidateRange(4499, 4507)][int]$WebPort = 4499,
    [ValidateSet('single', 'multi')][string]$TenantMode = 'single',
    [int]$TimeoutSeconds = 240
)
$ErrorActionPreference = 'Stop'
$ctl = 'C:\somework\qa-app\control'
if (-not (Test-Path (Join-Path $WebRoot 'package.json'))) { throw "no package.json in $WebRoot" }
function Test-Listening([int]$Port) { return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0 }
function Test-TaskRunning([string]$Name) { return @(& schtasks.exe /Query /TN $Name /FO LIST 2>$null | Select-String -Pattern 'Status:\s+Running').Count -gt 0 }
# A web launcher that is still "running" but does not serve this checkout blocks the task: Task Scheduler does not start a second instance, and the old one
# may be hung (a start that never printed anything held the task for 80 minutes). End it before anything is started, and only then clear the flags.
$previousRoot = if (Test-Path "$ctl\web-root.txt") { (Get-Content "$ctl\web-root.txt" -TotalCount 1).Trim() } else { '' }
if ((Test-TaskRunning 'QaAppWeb') -and ((-not (Test-Listening $WebPort)) -or ($previousRoot -ne $WebRoot))) {
    Set-Content "$ctl\stop-web" 'stop'
    $until = (Get-Date).AddSeconds(30)
    while ((Test-TaskRunning 'QaAppWeb') -and (Get-Date) -lt $until) { Start-Sleep -Seconds 2 }
    if (Test-TaskRunning 'QaAppWeb') { & schtasks.exe /End /TN QaAppWeb | Out-Null; Start-Sleep -Seconds 3 }
}
Set-Content "$ctl\web-root.txt" $WebRoot
Set-Content "$ctl\web-port.txt" $WebPort
Set-Content "$ctl\tenant-mode.txt" $TenantMode
Remove-Item "$ctl\stop-server", "$ctl\stop-web" -ErrorAction SilentlyContinue
function Test-Url([string]$Url) { try { return (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5).StatusCode -eq 200 } catch { return $false } }
if (-not (Test-Listening 8080)) { & schtasks.exe /Run /TN QaAppServer | Out-Null }
if (-not (Test-Listening $WebPort)) { & schtasks.exe /Run /TN QaAppWeb | Out-Null }
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    if ((Test-Url 'http://127.0.0.1:8080/health') -and (Test-Url "http://127.0.0.1:$WebPort/")) { $healthy = $true; break }
    Start-Sleep -Seconds 3
}
if (-not $healthy) { Write-Host 'FAIL: the stack did not become healthy in time (see C:\somework\qa-app\logs)'; exit 1 }
Write-Host "UP backend=http://127.0.0.1:8080 web=http://127.0.0.1:$WebPort tenantMode=$TenantMode"
