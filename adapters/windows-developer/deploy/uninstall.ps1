# Removes the Windows developer agent. By default only the task and the firewall rules go; the account, the code and the data stay
# unless you ask. Run it elevated. Windows PowerShell 5.1 compatible, ASCII only.
[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\somework\agent',
    [string]$WorkspaceRoot = 'C:\somework\workspaces',
    [string]$StateRoot = 'C:\somework\state',
    [string]$LogRoot = 'C:\somework\logs',
    [string]$SecretsRoot = 'C:\somework\secrets',
    [string]$ServiceUser = 'svc-somework',
    [string]$TaskName = 'SomeWorkWindowsDeveloper',
    [switch]$RemoveUser,
    [switch]$RemoveInstall,
    [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
if (-not (Test-Administrator)) { throw 'Run this script elevated (as an administrator).' }

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host ('task {0} removed' -f $TaskName)

$firewall = Join-Path $PSScriptRoot 'firewall.ps1'
if (Test-Path -LiteralPath $firewall) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $firewall -Remove -ServiceUser $ServiceUser }

if ($RemoveUser) {
    if (Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue) {
        $sid = Get-UserSid $ServiceUser
        foreach ($right in ($script:ServiceUserRights + $script:ServiceUserDeniedRights)) { Set-UserRight -Sid $sid -Right $right -Remove }
        Remove-LocalUser -Name $ServiceUser
        Write-Host ('account {0} removed' -f $ServiceUser)
    }
}
if ($RemoveInstall) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue; Write-Host 'installation removed' }
if ($RemoveData) {
    foreach ($path in @($WorkspaceRoot, $StateRoot, $LogRoot, $SecretsRoot)) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host 'workspaces, state, logs and secrets removed'
}
