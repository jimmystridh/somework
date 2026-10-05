# Smoke test on the machine: runs deploy\smoke.ts with the installed Node and reports the service's state. Prints PASS/FAIL lines and
# exits 1 when anything failed. Safe to run any time: it works in its own temporary directory and does not touch the agent's workspaces.
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\windows-developer\deploy\smoke.ps1
# Windows PowerShell 5.1 compatible, ASCII only.
[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\somework\agent',
    [string]$TaskName = 'SomeWorkWindowsDeveloper',
    [int]$HealthPort = 8081
)
$ErrorActionPreference = 'Stop'
$node = 'C:\Program Files\nodejs\node.exe'
$failed = 0
if (-not (Test-Path -LiteralPath $node)) { Write-Host 'FAIL: Node.js is not installed in C:\Program Files\nodejs'; exit 1 }
$appDirectory = Join-Path $InstallRoot 'adapters\windows-developer'
if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'deploy\smoke.ts'))) { Write-Host ('FAIL: the agent is not installed in ' + $InstallRoot); exit 1 }
Write-Host 'PASS: node and the installation are present'

$env:NODE_OPTIONS = '--disable-warning=ExperimentalWarning'
Push-Location $appDirectory
try {
    # Windows PowerShell 5.1 wraps every line a native program writes to stderr (git prints "Cloning into ..." there) in an error record, and
    # under 'Stop' that ends the script. The exit code is what counts, so let the lines through.
    $ErrorActionPreference = 'Continue'
    & $node 'deploy\smoke.ts' 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    if ($LASTEXITCODE -ne 0) { $failed = $failed + 1 }
} finally {
    $ErrorActionPreference = 'Stop'
    Pop-Location
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host ('INFO: scheduled task {0} is {1}' -f $TaskName, $task.State)
    try {
        $ready = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:{0}/ready' -f $HealthPort) -TimeoutSec 5
        Write-Host ('PASS: the service answers /ready: {0}' -f $ready.Content.Trim())
    } catch {
        Write-Host ('INFO: the service is not answering on port {0} ({1})' -f $HealthPort, $_.Exception.Message)
    }
} else {
    Write-Host ('INFO: scheduled task {0} is not installed' -f $TaskName)
}
if ($failed -gt 0) { Write-Host 'FAIL: the smoke checks failed'; exit 1 }
Write-Host 'PASS: all smoke checks passed'
exit 0
