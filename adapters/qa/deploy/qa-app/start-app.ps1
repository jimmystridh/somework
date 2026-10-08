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
$root = 'C:\somework\qa-app'
$ctl = "$root\control"
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
# the dev server hangs silently at its config step on about four starts in ten (bun with native modules on this two-processor machine; the same checkout starts fine on the next try):
# a normal start opens the port within 8 to 15 seconds, so one that has not after 40 is started again
$webStartedAt = Get-Date
$webRestarts = 0
while ((Get-Date) -lt $deadline) {
    if ((Test-Url 'http://127.0.0.1:8080/health') -and (Test-Url "http://127.0.0.1:$WebPort/")) { $healthy = $true; break }
    if (-not (Test-Listening $WebPort) -and $webRestarts -lt 8 -and ((Get-Date) - $webStartedAt).TotalSeconds -gt 40) {
        Write-Host "the web app is silent after 40 s: starting it again ($($webRestarts + 1) of 8)"
        Set-Content "$ctl\stop-web" 'stop'
        $until = (Get-Date).AddSeconds(30)
        while ((Test-TaskRunning 'QaAppWeb') -and (Get-Date) -lt $until) { Start-Sleep -Seconds 2 }
        if (Test-TaskRunning 'QaAppWeb') { & schtasks.exe /End /TN QaAppWeb | Out-Null; Start-Sleep -Seconds 3 }
        Remove-Item "$ctl\stop-web" -ErrorAction SilentlyContinue
        & schtasks.exe /Run /TN QaAppWeb | Out-Null
        $webRestarts++
        $webStartedAt = Get-Date
    }
    Start-Sleep -Seconds 3
}
if (-not $healthy) {
    $diag = New-Object System.Collections.Generic.List[string]
    $diag.Add('FAIL: the stack did not become healthy in time')
    foreach ($t in 'QaAppServer', 'QaAppWeb') { $diag.Add(("task {0}: {1}" -f $t, ((& schtasks.exe /Query /TN $t /FO LIST 2>$null | Select-String -Pattern 'Status:|Last Result:') -join ' '))) }
    $diag.Add(("listening: 8080={0} {1}={2}; web restarts={3}" -f (Test-Listening 8080), $WebPort, (Test-Listening $WebPort), $webRestarts))
    foreach ($f in 'web.log', 'web.err.log', 'bfs.err.log') {
        $path = "$root\logs\$f"
        try {
            if (-not (Test-Path $path)) { $diag.Add("${f}: missing"); continue }
            $diag.Add(("{0}: {1} bytes" -f $f, (Get-Item $path -ErrorAction Stop).Length))
            Get-Content $path -Tail 8 -ErrorAction Stop | ForEach-Object { $diag.Add("  $_") }
        } catch { $diag.Add("${f}: not readable") }
    }
    Get-Process bun, node, vite -ErrorAction SilentlyContinue | ForEach-Object { $diag.Add(("process {0} {1} cpu={2} started={3}" -f $_.Id, $_.ProcessName, [int]$_.CPU, $_.StartTime)) }
    # the agent shows only the beginning of this command's output, so the details also go to a file
    try { Set-Content "$ctl\last-start-failure.txt" $diag } catch { }
    Write-Host ($diag[0] + ' (details: C:\somework\qa-app\control\last-start-failure.txt)')
    exit 1
}
# the first page load of a cold dev server takes minutes here and an agent that meets a blank page gives up: load the initial module graph now
$warm = 'C:\somework\agent\adapters\qa\deploy\qa-app\warm-web.mjs'
if (Test-Path $warm) {
    $warmOutput = & node $warm $WebPort 180 2>&1 | Select-Object -Last 1
    Write-Host "warm-up: $warmOutput"
}
Write-Host "UP backend=http://127.0.0.1:8080 web=http://127.0.0.1:$WebPort tenantMode=$TenantMode"
