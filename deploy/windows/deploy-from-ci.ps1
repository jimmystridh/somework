# The only thing the CI deploy key may run on a Windows agent machine (administrators_authorized_keys line:
#   command="powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/somework/bin/deploy-from-ci.ps1",restrict,from="10.10.10.15" ssh-ed25519 ...).
#
#   tar czf payload.tgz <paths>; ssh machine "deploy <40-hex commit> <size of payload.tgz in bytes>" < payload.tgz
#
# It unpacks the tar from stdin, keeps a backup of what it replaces, installs the shared kit, the SDK and this machine's role (QA or the Windows developer;
# the role is read from agent.env) over C:\somework\agent, installs the role's profiles.pilot.json as profiles.json, runs `npm ci` when the lockfile
# changed, restarts the service and waits for /ready. When the service does not become ready it puts the backup back and starts the old code again
# (exit status 1). Install this file by hand once (C:\somework\bin, writable by administrators only): a key that could replace it could run anything as
# an administrator. Windows PowerShell 5.1, ASCII only.
$ErrorActionPreference = 'Stop'
$root = 'C:\somework'
$agent = "$root\agent"
$deploy = "$root\deploy"

function Fail([string]$message, [int]$code = 1) { [Console]::Error.WriteLine($message); exit $code }

# the size is given because Windows OpenSSH does not pass the end of the client's input on to the program: reading "until the end" would wait forever
if ($env:SSH_ORIGINAL_COMMAND -notmatch '^deploy ([0-9a-f]{40}) ([0-9]{1,9})$') { Fail 'only "deploy COMMIT_SHA SIZE" (the full lower-case hash, the archive size in bytes) is allowed' 2 }
$sha = $Matches[1]
$size = [int64]$Matches[2]
if ($size -lt 1 -or $size -gt 100MB) { Fail 'the archive must be between 1 byte and 100 MB' 2 }

$mutex = New-Object System.Threading.Mutex($false, 'Global\somework-deploy')
if (-not $mutex.WaitOne(0)) { Fail 'another deployment is running' 3 }

$settings = @{}
foreach ($line in Get-Content "$agent\agent.env") { if ($line -match '^([A-Z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] } }
$role = if ($settings.ContainsKey('QA_PROFILES_FILE')) { 'qa' } else { 'windows-developer' }
$package = "@somework/$role"
$task = if ($role -eq 'qa') { 'SomeWorkQa' } else { 'SomeWorkWindowsDeveloper' }
$bind = if ($settings.ContainsKey('WINDOWS_HEALTH_BIND')) { $settings['WINDOWS_HEALTH_BIND'] } else { '127.0.0.1' }
$port = $settings['HEALTH_PORT']
if (-not $port) { Fail 'HEALTH_PORT is not set in agent.env' }
Write-Host "deploying $sha to the $role machine"

New-Item -ItemType Directory -Force $deploy | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tgz = "$deploy\incoming.tgz"
$stage = "$deploy\stage"
$backup = "$deploy\backup\$stamp"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
$in = [Console]::OpenStandardInput()
$file = [IO.File]::Create($tgz)
$buffer = New-Object byte[] 65536
$left = $size
while ($left -gt 0) {
    $read = $in.Read($buffer, 0, [int][Math]::Min($buffer.Length, $left))
    if ($read -le 0) { $file.Close(); Fail "the archive ended after $($size - $left) of $size bytes" }
    $file.Write($buffer, 0, $read)
    $left -= $read
}
$file.Close()
& tar.exe -xzf $tgz -C $stage
if ($LASTEXITCODE -ne 0) { Fail 'the archive could not be unpacked' }
Remove-Item $tgz -Force

# what the deployment owns: mirrored directories, single files (from, to)
$mirrors = @('packages\agent-kit\src', 'sdk\typescript\src', "adapters\$role\src", "adapters\$role\deploy")
$files = @(
    @('package.json', 'package.json'), @('package-lock.json', 'package-lock.json'),
    @('packages\agent-kit\package.json', 'packages\agent-kit\package.json'), @('sdk\typescript\package.json', 'sdk\typescript\package.json'),
    @("adapters\$role\package.json", "adapters\$role\package.json"), @("adapters\$role\card.json", "adapters\$role\card.json"),
    @("adapters\$role\deploy\profiles.pilot.json", 'profiles.json'), @("adapters\$role\deploy\managed.env", 'managed.env')
)
foreach ($m in $mirrors) { if (-not (Test-Path "$stage\$m")) { Fail "the archive has no $m" } }
foreach ($f in $files) { if (-not (Test-Path "$stage\$($f[0])")) { Fail "the archive has no $($f[0])" } }

function Mirror([string]$from, [string]$to) {
    & robocopy.exe $from $to /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "robocopy failed for $to (exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}

# backup of what is about to be replaced
New-Item -ItemType Directory -Force $backup | Out-Null
foreach ($m in $mirrors) { if (Test-Path "$agent\$m") { Mirror "$agent\$m" "$backup\$m" } }
foreach ($f in $files) { if (Test-Path "$agent\$($f[1])") { $dest = "$backup\$($f[1])"; New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null; Copy-Item "$agent\$($f[1])" $dest -Force } }
Get-ChildItem "$deploy\backup" -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force

$lockChanged = (Test-Path "$agent\package-lock.json") -and ((Get-FileHash "$agent\package-lock.json").Hash -ne (Get-FileHash "$stage\package-lock.json").Hash)

# npm writes its warnings to stderr, which Windows PowerShell turns into errors: run it through cmd and look at the exit code only
function Install-Dependencies {
    Push-Location $agent
    try {
        $output = & cmd.exe /c "npm ci --omit=dev --ignore-scripts -w $package 2>&1"
        $code = $LASTEXITCODE
        $output | Select-Object -Last 4 | ForEach-Object { Write-Host $_ }
        return ($code -eq 0)
    } finally { Pop-Location }
}
function Install-Files {
    foreach ($m in $mirrors) { Mirror "$stage\$m" "$agent\$m" }
    foreach ($f in $files) { Copy-Item "$stage\$($f[0])" "$agent\$($f[1])" -Force }
}
function Restore-Backup {
    foreach ($m in $mirrors) { if (Test-Path "$backup\$m") { Mirror "$backup\$m" "$agent\$m" } }
    foreach ($f in $files) { if (Test-Path "$backup\$($f[1])") { Copy-Item "$backup\$($f[1])" "$agent\$($f[1])" -Force } }
}
function Wait-Ready([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $answer = Invoke-WebRequest -UseBasicParsing -Uri "http://${bind}:$port/ready" -TimeoutSec 5
            if ($answer.StatusCode -eq 200 -and $answer.Content -match '"ready"\s*:\s*true') { return $true }
        } catch { }
        Start-Sleep -Seconds 3
    }
    return $false
}
function Restart-Agent {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
    Start-ScheduledTask -TaskName $task
}

# what the machine's role needs to be fast and to work, idempotent: installing and building tens of thousands of small files under real-time scanning took a quarter
# of an hour (the exclusions are for these test machines' working directories only), and the QA web app runs as its own account that must read the checkouts
function Ensure-Access {
    $excluded = @("$root\workspaces")
    if ($role -eq 'qa') { $excluded += @("$root\qa-app", 'C:\tools\bun', 'C:\Users\svc-qa\.bun', 'C:\Users\svc-qa\AppData\Local\Temp') }
    foreach ($path in $excluded) { Add-MpPreference -ExclusionPath $path -ErrorAction SilentlyContinue }
    if ($role -eq 'qa') { & icacls.exe "$root\workspaces" /grant 'svc-qa-web:(OI)(CI)M' | Out-Null }
}
Ensure-Access

# the outbound allow list of the service account lives in the repository: the machine's firewall refresh task reads it from wherever its -AllowFile says
function Update-FirewallAllowList {
    $source = "$stage\adapters\$role\deploy\firewall-allow.pilot.txt"
    if (-not (Test-Path $source)) { return }
    $refresh = Get-ScheduledTask | Where-Object { $_.TaskName -like '*FirewallRefresh*' } | Select-Object -First 1
    if (-not $refresh) { return }
    $arguments = [string](($refresh.Actions | Select-Object -First 1).Arguments)
    if ($arguments -notmatch '-AllowFile\s+"([^"]+)"') { return }
    $target = $Matches[1]
    if ((Test-Path $target) -and ((Get-FileHash $target).Hash -eq (Get-FileHash $source).Hash)) { return }
    Copy-Item $source $target -Force
    Start-ScheduledTask -TaskName $refresh.TaskName
    Write-Host "the firewall allow list was updated: $target"
}
Update-FirewallAllowList

trap {
    [Console]::Error.WriteLine("unexpected error: $($_.Exception.Message)")
    try { Restore-Backup } catch { }
    try { Start-ScheduledTask -TaskName $task } catch { }
    exit 1
}
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Install-Files
if ($lockChanged) {
    Write-Host "the lockfile changed: npm ci for $package"
    if (-not (Install-Dependencies)) { Write-Host 'npm ci failed'; Restore-Backup; Restart-Agent; Fail 'npm ci failed: the old code was put back' }
}
Start-ScheduledTask -TaskName $task
if (Wait-Ready 120) {
    Remove-Item $stage -Recurse -Force
    Write-Host "deployed $sha ($role): ready"
    exit 0
}
Write-Host "the $role agent did not become ready in 120 s: putting the old code back"
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Restore-Backup
if ($lockChanged) { Install-Dependencies | Out-Null }
Start-ScheduledTask -TaskName $task
if (Wait-Ready 120) { Fail 'the new code did not start; the old code is running again' }
Fail 'the new code did not start and neither did the old code: look at the machine'
