# Runs the admin web app's dev server (bun + vite) in its auth-less local mode, under Task Scheduler as an unprivileged account.
# Reads the folder (Source\admin.web of a checkout), port and tenant mode from files written by start-app.ps1. Stops when control\stop-web appears.
$ErrorActionPreference = 'Stop'
$root = 'C:\somework\qa-app'
$logs = "$root\logs"; $ctl = "$root\control"; $pids = "$root\pids"
foreach ($d in $logs, $ctl, $pids) { New-Item -ItemType Directory -Force $d | Out-Null }
$stopFlag = "$ctl\stop-web"
Remove-Item $stopFlag -ErrorAction SilentlyContinue
$web = (Get-Content "$ctl\web-root.txt" -TotalCount 1).Trim()
$port = [int](Get-Content "$ctl\web-port.txt" -TotalCount 1)
$tenantMode = (Get-Content "$ctl\tenant-mode.txt" -TotalCount 1).Trim()
if ($port -lt 4499 -or $port -gt 4507) { throw "port $port is outside the registered range 4499-4507" }
if (-not (Test-Path "$web\package.json")) { throw "no package.json in $web" }
if (@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -gt 0) { "the web app already listens on $port"; exit 0 }
$bunDir = 'C:\tools\bun'
$env:Path = "$bunDir;" + $env:Path
Set-Location $web
# the example env file is the base; only the three settings that select the local, auth-less mode are changed
$example = Get-Content (Join-Path $web 'env.local.example') -Encoding UTF8
$settings = @{ VITE_API_URL = 'http://127.0.0.1:8080'; VITE_AUTH_MODE = 'none'; VITE_TENANT_MODE = $tenantMode; VITE_OIDC_REDIRECT_URI = "http://localhost:$port" }
$lines = foreach ($line in $example) {
    $m = [regex]::Match($line, '^([A-Z0-9_]+)=')
    if ($m.Success -and $settings.ContainsKey($m.Groups[1].Value)) { $m.Groups[1].Value + '=' + $settings[$m.Groups[1].Value] } else { $line }
}
[IO.File]::WriteAllText((Join-Path $web '.env.local'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
foreach ($f in 'web.log', 'web.err.log') { if ((Test-Path "$logs\$f") -and ((Get-Item "$logs\$f").Length -gt 20MB)) { Move-Item "$logs\$f" "$logs\$f.1" -Force } }
$env:APP_PORT = "$port"
$bunArgs = @('--no-env-file', 'scripts/run-vite-with-mode-env.mjs', 'local', '--port', "$port", '--strictPort', '--host', '127.0.0.1')
$p = Start-Process -FilePath "$bunDir\bun.exe" -ArgumentList $bunArgs -WorkingDirectory $web -PassThru -WindowStyle Hidden -RedirectStandardOutput "$logs\web.log" -RedirectStandardError "$logs\web.err.log"
Set-Content "$pids\web.pid" $p.Id
$startedAt = Get-Date
while (-not $p.HasExited) {
    # an application that never opens its port is not left holding the task: after 15 minutes it is ended and the next start gets a clean launcher
    if (((Get-Date) - $startedAt).TotalSeconds -gt 900 -and @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -eq 0) {
        & taskkill.exe /PID $p.Id /T /F | Out-Null
        Remove-Item "$pids\web.pid" -ErrorAction SilentlyContinue; exit 1
    }
    if (Test-Path $stopFlag) {
        # vite runs as a child of the launcher: end the whole tree
        & taskkill.exe /PID $p.Id /T /F | Out-Null
        Remove-Item $stopFlag -Force; Remove-Item "$pids\web.pid" -ErrorAction SilentlyContinue; exit 0
    }
    Start-Sleep -Seconds 2
}
Remove-Item "$pids\web.pid" -ErrorAction SilentlyContinue
exit 1
