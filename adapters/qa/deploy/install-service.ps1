# Installs the QA agent as an unprivileged service account running from a scheduled task. Idempotent: run it again to
# update the code, the settings or the account's password. Run it elevated, from the repository tree (or a copy of it):
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-service.ps1 -SourcePath C:\path\to\somework -EnvFile C:\path\agent.env -Start
# Windows PowerShell 5.1 compatible, ASCII only.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [string]$EnvFile = '',
    [string]$ProfilesFile = '',
    [string]$OverlayFile = '',
    [string]$InstallRoot = 'C:\somework\agent',
    [string]$WorkspaceRoot = 'C:\somework\workspaces',
    [string]$StateRoot = 'C:\somework\state',
    [string]$LogRoot = 'C:\somework\logs',
    [string]$SecretsRoot = 'C:\somework\secrets',
    [string]$ServiceUser = 'svc-qa',
    [string]$TaskName = 'SomeWorkQa',
    [switch]$SkipInstallDependencies,
    [switch]$SmokeAsService,
    [switch]$Start
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

if (-not (Test-Administrator)) { throw 'Run this script elevated (as an administrator).' }
foreach ($required in @('package.json', 'package-lock.json', 'sdk\typescript\package.json', 'packages\agent-kit\package.json', 'adapters\qa\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourcePath $required))) { throw ('SourcePath does not look like the repository tree: missing {0}' -f $required) }
}
$node = 'C:\Program Files\nodejs\node.exe'
$npm = 'C:\Program Files\nodejs\npm.cmd'
if (-not (Test-Path -LiteralPath $node)) { throw 'Node.js (the official build, 22.19 or newer) is not installed in C:\Program Files\nodejs.' }

# 1. the account: local, not an administrator, never able to log on interactively, remotely or over the network
$password = New-RandomPassword
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
if (Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $ServiceUser -Password $securePassword
    Write-Host ('account {0} exists; password rotated' -f $ServiceUser)
} else {
    New-LocalUser -Name $ServiceUser -Password $securePassword -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description 'SomeWork QA agent (service)' | Out-Null
    Write-Host ('account {0} created' -f $ServiceUser)
}
Remove-LocalGroupMember -Group 'Administrators' -Member $ServiceUser -ErrorAction SilentlyContinue
$sid = Get-UserSid $ServiceUser
foreach ($right in $script:ServiceUserRights) { Set-UserRight -Sid $sid -Right $right }
foreach ($right in $script:ServiceUserDeniedRights) { Set-UserRight -Sid $sid -Right $right }

# 2. directories: code read-only, workspaces/state/logs writable, secrets read-only for the account
Set-DirectoryAcl -Path $WorkspaceRoot -Sid $sid -Rights 'M'
Set-DirectoryAcl -Path $StateRoot -Sid $sid -Rights 'M'
Set-DirectoryAcl -Path $LogRoot -Sid $sid -Rights 'M'
Set-DirectoryAcl -Path $SecretsRoot -Sid $sid -Rights 'R'

# 3. the code: only what the role needs (no other role, no Rust, no docs), then the production dependencies from the lockfile
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
foreach ($file in @('package.json', 'package-lock.json', '.npmrc')) {
    if (Test-Path -LiteralPath (Join-Path $SourcePath $file)) { Copy-Item -LiteralPath (Join-Path $SourcePath $file) -Destination (Join-Path $InstallRoot $file) -Force }
}
foreach ($tree in @('sdk\typescript', 'packages\agent-kit', 'adapters\qa')) {
    $destination = Join-Path $InstallRoot $tree
    & robocopy.exe (Join-Path $SourcePath $tree) $destination /MIR /XD node_modules .git /XF agent.env profiles.json /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ('robocopy failed for {0} (exit {1})' -f $tree, $LASTEXITCODE) }
}
# the other workspaces only contribute their manifests, so the single lockfile stays valid
foreach ($manifest in (Get-ChildItem -Path (Join-Path $SourcePath 'adapters') -Directory)) {
    if ($manifest.Name -eq 'qa') { continue }
    $target = Join-Path (Join-Path $InstallRoot 'adapters') $manifest.Name
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath (Join-Path $manifest.FullName 'package.json') -Destination (Join-Path $target 'package.json') -Force
}
if (-not $SkipInstallDependencies) {
    Push-Location $InstallRoot
    try {
        & $npm ci --omit=dev --ignore-scripts -w '@somework/qa'
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    } finally {
        Pop-Location
    }
}

# 4. settings (no secrets in them) and the build/test profiles
$targetEnv = Join-Path $InstallRoot 'agent.env'
if ($EnvFile) { Copy-Item -LiteralPath $EnvFile -Destination $targetEnv -Force }
elseif (-not (Test-Path -LiteralPath $targetEnv)) { throw 'There is no agent.env yet: pass -EnvFile (start from deploy\agent.env.example).' }
if ($ProfilesFile) { Copy-Item -LiteralPath $ProfilesFile -Destination (Join-Path $InstallRoot 'profiles.json') -Force }
if ($OverlayFile) {
    $overlayDirectory = Join-Path $InstallRoot 'skills-overlay'
    New-Item -ItemType Directory -Force -Path $overlayDirectory | Out-Null
    Copy-Item -LiteralPath $OverlayFile -Destination (Join-Path $overlayDirectory 'qa.md') -Force
}
Set-DirectoryAcl -Path $InstallRoot -Sid $sid -Rights 'RX' -Recurse

# 5. the scheduled task: at boot, as the service account, restarted by the supervisor and by the task settings
$runner = Join-Path $InstallRoot 'adapters\qa\deploy\run-agent.ps1'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -LogRoot "{2}"' -f $runner, $InstallRoot, $LogRoot
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User ('{0}\{1}' -f $env:COMPUTERNAME, $ServiceUser) -Password $password -RunLevel Limited -Description 'SomeWork QA agent' | Out-Null
Write-Host ('scheduled task {0} registered for {1}' -f $TaskName, $ServiceUser)

# 6. optional: run the smoke test AS the service account, which is the only way to learn whether Edge starts for it. The account may not
#    log on interactively and nobody knows its password, so a second task with the same fresh password runs the smoke test, and a
#    throwaway SYSTEM task starts it (an administrator may not start a task that belongs to another account).
if ($SmokeAsService) {
    $smokeTask = $TaskName + 'Smoke'
    $helperTask = $TaskName + 'SmokeStart'
    $smokeLog = Join-Path $LogRoot 'smoke-as-service.log'
    Remove-Item -LiteralPath $smokeLog -Force -ErrorAction SilentlyContinue
    $smokeScript = Join-Path $InstallRoot 'adapters\qa\deploy\smoke.ps1'
    $smokeArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -LogFile "{2}"' -f $smokeScript, $InstallRoot, $smokeLog
    Unregister-ScheduledTask -TaskName $smokeTask -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $helperTask -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $smokeTask -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $smokeArguments) -User ('{0}\{1}' -f $env:COMPUTERNAME, $ServiceUser) -Password $password -RunLevel Limited | Out-Null
    Register-ScheduledTask -TaskName $helperTask -Action (New-ScheduledTaskAction -Execute 'schtasks.exe' -Argument ('/Run /TN {0}' -f $smokeTask)) -User 'SYSTEM' -RunLevel Highest | Out-Null
    Start-ScheduledTask -TaskName $helperTask
    $deadline = (Get-Date).AddMinutes(10)
    Start-Sleep -Seconds 10
    while (((Get-ScheduledTask -TaskName $smokeTask).State -eq 'Running') -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 5 }
    $smokeResult = (Get-ScheduledTaskInfo -TaskName $smokeTask).LastTaskResult
    if (Test-Path -LiteralPath $smokeLog) { Get-Content -LiteralPath $smokeLog | ForEach-Object { Write-Host ('  | ' + $_) } } else { Write-Host 'the smoke test left no log (it did not start?)' }
    Write-Host ('smoke test as {0}: task result {1} (0 means every check passed)' -f $ServiceUser, $smokeResult)
    Unregister-ScheduledTask -TaskName $smokeTask -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $helperTask -Confirm:$false -ErrorAction SilentlyContinue
}
$password = $null

if ($Start) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host ('started; follow {0}' -f (Join-Path $LogRoot 'supervisor.log'))
}
Write-Host 'next: put the key, CA, git token and the ticket system certificate and token in the secrets directory, put the skill overlay in skills-overlay, run firewall.ps1, then smoke.ps1 (see deploy\README.md)'
