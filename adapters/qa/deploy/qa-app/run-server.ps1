# Runs the product's back-end server (Adm.exe /server) under Task Scheduler as SYSTEM (SQL Server knows SYSTEM as sysadmin; no desktop needed).
# Stops when C:\somework\qa-app\control\stop-server appears. Windows PowerShell 5.1, ASCII only.
$ErrorActionPreference = 'Stop'
$root = 'C:\somework\qa-app'
$logs = "$root\logs"; $ctl = "$root\control"; $pids = "$root\pids"
foreach ($d in $logs, $ctl, $pids) { New-Item -ItemType Directory -Force $d | Out-Null }
$stopFlag = "$ctl\stop-server"
Remove-Item $stopFlag -ErrorAction SilentlyContinue
if (@(Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue).Count -gt 0) { 'the server already listens on 8080'; exit 0 }
$dir = (Get-Content "$root\server-dir.txt" -TotalCount 1).Trim()
if (-not (Test-Path "$dir\Adm.exe")) { throw "Adm.exe not found in $dir" }
if (-not (Test-Path "$dir\config.json")) { throw "config.json not found in $dir" }
foreach ($f in 'bfs.log', 'bfs.err.log') { if ((Test-Path "$logs\$f") -and ((Get-Item "$logs\$f").Length -gt 20MB)) { Move-Item "$logs\$f" "$logs\$f.1" -Force } }
$p = Start-Process -FilePath "$dir\Adm.exe" -ArgumentList '/server' -WorkingDirectory $dir -PassThru -WindowStyle Hidden -RedirectStandardOutput "$logs\bfs.log" -RedirectStandardError "$logs\bfs.err.log"
Set-Content "$pids\server.pid" $p.Id
while (-not $p.HasExited) {
    if (Test-Path $stopFlag) { Stop-Process -Id $p.Id -Force; Remove-Item $stopFlag -Force; Remove-Item "$pids\server.pid" -ErrorAction SilentlyContinue; exit 0 }
    Start-Sleep -Seconds 2
}
Remove-Item "$pids\server.pid" -ErrorAction SilentlyContinue
exit 1
