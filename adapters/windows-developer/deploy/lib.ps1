# Shared helpers of install-service.ps1 and uninstall.ps1. Windows PowerShell 5.1 compatible (no && / || / ?? / ternary), ASCII only.

function Test-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-RandomPassword {
    $bytes = New-Object byte[] 24
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $rng.GetBytes($bytes)
    $rng.Dispose()
    # the fixed prefix satisfies password complexity policies; the rest is 192 random bits
    return 'Aa1!' + [Convert]::ToBase64String($bytes).Replace('/', 'x').Replace('+', 'y').Replace('=', 'z')
}

function Get-UserSid([string]$Name) {
    $account = New-Object System.Security.Principal.NTAccount($Name)
    return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

# Only the Administrators and SYSTEM keep full control; the service user gets exactly $Rights (RX, R or M) and nothing is inherited.
function Set-DirectoryAcl([string]$Path, [string]$Sid, [string]$Rights, [switch]$Recurse) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $arguments = @($Path, '/inheritance:r', '/grant:r', 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F', ('*{0}:(OI)(CI){1}' -f $Sid, $Rights), '/C', '/Q')
    if ($Recurse) { $arguments += '/T' }
    & icacls.exe @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('icacls failed for {0} (exit {1})' -f $Path, $LASTEXITCODE) }
}

# Adds (or removes) a user right such as SeBatchLogonRight / SeDenyNetworkLogonRight for a SID, through secedit.
function Set-UserRight([string]$Sid, [string]$Right, [switch]$Remove) {
    $work = Join-Path $env:TEMP ('secedit-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $exported = Join-Path $work 'current.inf'
        $updated = Join-Path $work 'updated.inf'
        & secedit.exe /export /cfg $exported /areas USER_RIGHTS | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'secedit /export failed' }
        $mine = '*' + $Sid
        $found = $false
        $result = New-Object System.Collections.Generic.List[string]
        $headerAt = -1
        foreach ($line in (Get-Content -LiteralPath $exported)) {
            if ($line -match '^\[Privilege Rights\]') { $headerAt = $result.Count }
            if ($line -match ('^' + [regex]::Escape($Right) + '\s*=\s*(.*)$')) {
                $found = $true
                $entries = @($Matches[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
                if ($Remove) { $entries = @($entries | Where-Object { $_ -ne $mine }) }
                elseif ($entries -notcontains $mine) { $entries += $mine }
                $result.Add($Right + ' = ' + ($entries -join ','))
            } else {
                $result.Add($line)
            }
        }
        if (-not $found -and -not $Remove) {
            if ($headerAt -lt 0) { throw 'no [Privilege Rights] section in the exported security policy' }
            $result.Insert($headerAt + 1, $Right + ' = ' + $mine)
        }
        Set-Content -LiteralPath $updated -Value $result -Encoding Unicode
        & secedit.exe /configure /db (Join-Path $work 'secedit.sdb') /cfg $updated /areas USER_RIGHTS /quiet | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('secedit /configure failed for ' + $Right) }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$script:ServiceUserRights = @('SeBatchLogonRight')
$script:ServiceUserDeniedRights = @('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight')
