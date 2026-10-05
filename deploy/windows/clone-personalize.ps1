<#
.SYNOPSIS
  Gives a clone of the Windows golden image its own identity. PowerShell 5.1 compatible (no && or ?.).

.DESCRIPTION
  A clone of the golden image is born with the original's computer name, Tailscale node key, SSH host keys and SQL Server name.
  Run Stage 1 on the clone BEFORE it ever reaches the network (boot it with the NIC link down and run this through the QEMU guest
  agent), reboot, reconnect the NIC, then run Stage 2 over SSH as an administrator.

  Stage 1: refuses to run while a network link is up (unless -AllowNetwork), forgets the Tailscale node identity WITHOUT logging out
           (a logout would deregister the original, which shares the key), regenerates SSH host keys, renames the computer.
  Stage 2: after the reboot, repoints the SQL Server instance name at the new computer name and lists files and registry values that still
           mention the old name (reported, never rewritten).

  Idempotent: each stage can be run again.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,14}$')][string]$NewName,
    [ValidateSet(1, 2)][int]$Stage = 1,
    [string]$SqlInstance = 'SQLEXPRESS',
    # Folders and registry keys of installed software that may store the computer name; they are searched and reported, never rewritten.
    [string[]]$SearchRoots = @(),
    [string[]]$RegistryRoots = @(),
    [string]$OldName = '',
    [switch]$AllowNetwork
)

$ErrorActionPreference = 'Stop'
$logDir = 'C:\AgentClusterSetup'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'clone-personalize.log'
$marker = Join-Path $logDir 'clone-identity.json'

function Write-Log([string]$message) {
    $line = '[{0}] {1}' -f (Get-Date -Format o), $message
    Add-Content -Path $log -Value $line
    Write-Output $line
}

function Get-NamedIdentity {
    if (Test-Path $marker) { return (Get-Content $marker -Raw | ConvertFrom-Json) }
    return $null
}

function Test-NetworkLinkUp {
    $up = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }
    return @($up).Count -gt 0
}

function Invoke-Stage1 {
    $current = $env:COMPUTERNAME
    Write-Log "stage 1 on '$current' -> '$NewName'"
    if ((Test-NetworkLinkUp) -and -not $AllowNetwork) {
        throw 'A network link is up. Boot the clone with the NIC link down first: a duplicate Tailscale node key on the network would disturb the original. Use -AllowNetwork only if you know the original is off.'
    }

    # 1. Tailscale: forget the node identity locally. Never run "tailscale logout" here: it would remove the shared node.
    $tsService = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
    if ($tsService) {
        Stop-Service -Name 'Tailscale' -Force -ErrorAction SilentlyContinue
        foreach ($item in 'server-state.conf', 'profile-data') {
            $path = Join-Path 'C:\ProgramData\Tailscale' $item
            if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
        }
        Set-Service -Name 'Tailscale' -StartupType Manual
        Write-Log 'tailscale: local node state removed, service set to manual (join later with an auth key)'
    }

    # 2. SSH host keys
    $sshd = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
    if ($sshd) {
        Stop-Service -Name 'sshd' -Force -ErrorAction SilentlyContinue
        Get-ChildItem 'C:\ProgramData\ssh' -Filter 'ssh_host_*' -ErrorAction SilentlyContinue | Remove-Item -Force
        & "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe" -A | Out-Null
        $fix = "$env:WINDIR\System32\OpenSSH\FixHostFilePermissions.ps1"
        if (Test-Path $fix) { & $fix -Confirm:$false | Out-Null }
        Start-Service -Name 'sshd'
        Write-Log 'sshd: host keys regenerated'
    }

    # 3. Computer name (effective after the reboot)
    if ($current -ne $NewName) {
        Rename-Computer -NewName $NewName -Force
        Write-Log "computer renamed to $NewName (reboot required)"
    }

    $oldName = if ($OldName) { $OldName } elseif (Get-NamedIdentity) { (Get-NamedIdentity).oldName } else { $current }
    @{ oldName = $oldName; newName = $NewName; stage1 = (Get-Date -Format o) } | ConvertTo-Json | Set-Content $marker
    Write-Log 'stage 1 done: reboot, reconnect the NIC, then run stage 2'
}

function Invoke-Stage2 {
    $identity = Get-NamedIdentity
    $oldName = if ($OldName) { $OldName } elseif ($identity) { $identity.oldName } else { $null }
    if (-not $oldName) { throw 'The previous computer name is unknown: pass -OldName.' }
    if ($env:COMPUTERNAME -ne $NewName) { throw "The computer is called $($env:COMPUTERNAME), not ${NewName}: reboot after stage 1 first." }
    Write-Log "stage 2 on '$NewName' (was '$oldName')"

    # SQL Server remembers the name it was installed under; repoint it. Instance start is delayed, so wait for it.
    $serviceName = 'MSSQL$' + $SqlInstance
    $deadline = (Get-Date).AddMinutes(8)
    while ((Get-Service -Name $serviceName).Status -ne 'Running' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 10 }
    if ((Get-Service -Name $serviceName).Status -ne 'Running') { Start-Service -Name $serviceName }
    $connection = New-Object System.Data.SqlClient.SqlConnection ("Server=.\$SqlInstance;Integrated Security=SSPI;TrustServerCertificate=True;Connect Timeout=30")
    $connection.Open()
    try {
        $command = $connection.CreateCommand()
        $command.CommandText = 'select @@SERVERNAME'
        $serverName = [string]$command.ExecuteScalar()
        $wanted = "$NewName\$SqlInstance"
        if ($serverName -ne $wanted) {
            $command.CommandText = "exec sp_dropserver @server = N'$serverName'; exec sp_addserver @server = N'$wanted', @local = 'local';"
            [void]$command.ExecuteNonQuery()
            Write-Log "sql: server name $serverName -> $wanted (takes effect after the SQL service restarts)"
            $connection.Close()
            Restart-Service -Name $serviceName -Force
            Start-Sleep -Seconds 15
            $connection.Open()
            $command = $connection.CreateCommand()
            $command.CommandText = 'select @@SERVERNAME'
            Write-Log ("sql: @@SERVERNAME is now " + [string]$command.ExecuteScalar())
        } else {
            Write-Log "sql: server name already $serverName"
        }
    } finally {
        $connection.Close()
    }

    # Anything else that still carries the old computer name is reported, not rewritten.
    $hits = @()
    foreach ($root in $SearchRoots) {
        if (-not (Test-Path $root)) { continue }
        $hits += Get-ChildItem $root -Recurse -File -Include *.config, *.ini, *.xml, *.json, *.txt -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -lt 2MB } |
            Select-String -Pattern ([regex]::Escape($oldName)) -List -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Path }
    }
    foreach ($key in $RegistryRoots) {
        if (-not (Test-Path $key)) { continue }
        Get-ChildItem $key -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            $item = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
            foreach ($property in $item.PSObject.Properties) {
                if ($property.Value -is [string] -and $property.Value -match [regex]::Escape($oldName)) { $hits += ("{0} [{1}]" -f $_.Name, $property.Name) }
            }
        }
    }
    if ($hits.Count -gt 0) { Write-Log ("still mentions '$oldName' (review, not changed): " + ($hits -join '; ')) } else { Write-Log "nothing else mentions '$oldName'" }

    $identity = Get-NamedIdentity
    if ($identity) { $identity | Add-Member -NotePropertyName stage2 -NotePropertyValue (Get-Date -Format o) -Force; $identity | ConvertTo-Json | Set-Content $marker }
    Write-Log 'stage 2 done'
}

if ($Stage -eq 1) { Invoke-Stage1 } else { Invoke-Stage2 }
