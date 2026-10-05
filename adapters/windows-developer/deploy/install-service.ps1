# Installs the Windows developer agent as an unprivileged service account running from a scheduled task. Idempotent: run it again to
# update the code, the settings or the account's password. Run it elevated, from the repository tree (or a copy of it):
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-service.ps1 -SourcePath C:\path\to\somework -EnvFile C:\path\agent.env -Start
# Windows PowerShell 5.1 compatible, ASCII only.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [string]$EnvFile = '',
    [string]$ProfilesFile = '',
    [string]$InstallRoot = 'C:\somework\agent',
    [string]$WorkspaceRoot = 'C:\somework\workspaces',
    [string]$StateRoot = 'C:\somework\state',
    [string]$LogRoot = 'C:\somework\logs',
    [string]$SecretsRoot = 'C:\somework\secrets',
    [string]$ServiceUser = 'svc-somework',
    [string]$TaskName = 'SomeWorkWindowsDeveloper',
    [switch]$SkipInstallDependencies,
    [switch]$Start
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

if (-not (Test-Administrator)) { throw 'Run this script elevated (as an administrator).' }
foreach ($required in @('package.json', 'package-lock.json', 'sdk\typescript\package.json', 'packages\agent-kit\package.json', 'adapters\windows-developer\package.json')) {
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
    New-LocalUser -Name $ServiceUser -Password $securePassword -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description 'SomeWork Windows developer agent (service)' | Out-Null
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
foreach ($tree in @('sdk\typescript', 'packages\agent-kit', 'adapters\windows-developer')) {
    $destination = Join-Path $InstallRoot $tree
    & robocopy.exe (Join-Path $SourcePath $tree) $destination /MIR /XD node_modules .git /XF agent.env profiles.json /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ('robocopy failed for {0} (exit {1})' -f $tree, $LASTEXITCODE) }
}
# the other workspaces only contribute their manifests, so the single lockfile stays valid
foreach ($manifest in (Get-ChildItem -Path (Join-Path $SourcePath 'adapters') -Directory)) {
    if ($manifest.Name -eq 'windows-developer') { continue }
    $target = Join-Path (Join-Path $InstallRoot 'adapters') $manifest.Name
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath (Join-Path $manifest.FullName 'package.json') -Destination (Join-Path $target 'package.json') -Force
}
if (-not $SkipInstallDependencies) {
    Push-Location $InstallRoot
    try {
        & $npm ci --omit=dev --ignore-scripts -w '@somework/windows-developer'
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
Set-DirectoryAcl -Path $InstallRoot -Sid $sid -Rights 'RX' -Recurse

# 5. the scheduled task: at boot, as the service account, restarted by the supervisor and by the task settings
$runner = Join-Path $InstallRoot 'adapters\windows-developer\deploy\run-agent.ps1'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -LogRoot "{2}"' -f $runner, $InstallRoot, $LogRoot
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User ('{0}\{1}' -f $env:COMPUTERNAME, $ServiceUser) -Password $password -RunLevel Limited -Description 'SomeWork Windows developer agent' | Out-Null
$password = $null
Write-Host ('scheduled task {0} registered for {1}' -f $TaskName, $ServiceUser)

if ($Start) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host ('started; follow {0}' -f (Join-Path $LogRoot 'supervisor.log'))
}
Write-Host 'next: put the key, CA and git token in the secrets directory, run firewall.ps1, then smoke.ps1 (see deploy\README.md)'
