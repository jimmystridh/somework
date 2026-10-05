# Outbound allow-list for the service account, built from Windows Firewall rules. Windows Firewall lets a block rule win over an allow
# rule, so a per-user "allow these, block the rest" is expressed as BLOCK rules for the complement of the allowed IPv4 ranges.
#   firewall.ps1 -AllowFile C:\somework\agent\firewall-allow.txt             apply (resolves host names now)
#   firewall.ps1 -AllowFile ... -RegisterRefreshTask                         also re-resolve every 30 minutes (host names change addresses)
#   firewall.ps1 -Remove                                                     delete the rules and the refresh task
#   firewall.ps1 -SelfTest                                                   check the range arithmetic only; changes nothing
# Limits (see README.md): rules match addresses, not names, so a shared CDN address admits every site on it; IPv6 is blocked outright;
# only this account is restricted; an administrator can change the rules. Windows PowerShell 5.1 compatible, ASCII only.
[CmdletBinding()]
param(
    [string]$AllowFile = 'C:\somework\agent\firewall-allow.txt',
    [string]$ServiceUser = 'svc-somework',
    [string]$RulePrefix = 'SomeWork-Agent',
    [string]$RefreshTaskName = 'SomeWorkFirewallRefresh',
    [switch]$RegisterRefreshTask,
    [switch]$Remove,
    [switch]$DryRun,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$space = [long]4294967296

function ConvertTo-Number([string]$Address) {
    $bytes = ([System.Net.IPAddress]::Parse($Address)).GetAddressBytes()
    if ($bytes.Length -ne 4) { throw ('not an IPv4 address: ' + $Address) }
    return ([long]$bytes[0] * 16777216) + ([long]$bytes[1] * 65536) + ([long]$bytes[2] * 256) + [long]$bytes[3]
}

function ConvertFrom-Number([long]$Value) {
    return '{0}.{1}.{2}.{3}' -f [int][Math]::Floor($Value / 16777216), ([int][Math]::Floor($Value / 65536) % 256), ([int][Math]::Floor($Value / 256) % 256), ([int]($Value % 256))
}

# "10.0.0.5", "10.0.0.0/24" or "10.0.0.1-10.0.0.9" as @(first, last)
function ConvertTo-Interval([string]$Text) {
    if ($Text -match '^(\d+\.\d+\.\d+\.\d+)/(\d+)$') {
        $prefix = [int]$Matches[2]
        if ($prefix -lt 0 -or $prefix -gt 32) { throw ('bad prefix in ' + $Text) }
        $size = [long][Math]::Pow(2, 32 - $prefix)
        $first = [long][Math]::Floor((ConvertTo-Number $Matches[1]) / $size) * $size
        return @($first, ($first + $size - 1))
    }
    if ($Text -match '^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$') {
        $a = ConvertTo-Number $Matches[1]
        $b = ConvertTo-Number $Matches[2]
        if ($b -lt $a) { throw ('range runs backwards: ' + $Text) }
        return @($a, $b)
    }
    $single = ConvertTo-Number $Text
    return @($single, $single)
}

# merges overlapping and adjacent intervals
function Merge-Intervals($Intervals) {
    $sorted = @($Intervals | Sort-Object { $_[0] })
    $merged = New-Object System.Collections.ArrayList
    foreach ($interval in $sorted) {
        if ($merged.Count -gt 0 -and $interval[0] -le ($merged[$merged.Count - 1][1] + 1)) {
            if ($interval[1] -gt $merged[$merged.Count - 1][1]) { $merged[$merged.Count - 1] = @($merged[$merged.Count - 1][0], $interval[1]) }
        } else {
            [void]$merged.Add(@($interval[0], $interval[1]))
        }
    }
    return , @($merged.ToArray())
}

# everything in 0.0.0.0-255.255.255.255 that is not in $Allowed, as "a.b.c.d-e.f.g.h" strings
function Get-Complement($Allowed) {
    $merged = Merge-Intervals $Allowed
    $ranges = New-Object System.Collections.ArrayList
    $next = [long]0
    foreach ($interval in $merged) {
        if ($interval[0] -gt $next) { [void]$ranges.Add(@($next, ($interval[0] - 1))) }
        $next = $interval[1] + 1
    }
    if ($next -le ($space - 1)) { [void]$ranges.Add(@($next, ($space - 1))) }
    return , @($ranges.ToArray())
}

function Format-Range($Interval) {
    return '{0}-{1}' -f (ConvertFrom-Number $Interval[0]), (ConvertFrom-Number $Interval[1])
}

function Invoke-SelfTest {
    $script:failures = 0
    $check = {
        param([string]$Name, [bool]$Condition)
        if ($Condition) { Write-Host ('PASS: ' + $Name) } else { Write-Host ('FAIL: ' + $Name); $script:failures = $script:failures + 1 }
    }
    $allowed = @((ConvertTo-Interval '10.0.0.5'), (ConvertTo-Interval '1.2.3.4-1.2.3.10'), (ConvertTo-Interval '192.168.0.0/16'), (ConvertTo-Interval '127.0.0.0/8'), (ConvertTo-Interval '1.2.3.11'))
    $merged = Merge-Intervals $allowed
    & $check 'adjacent ranges merge (1.2.3.4-1.2.3.10 and 1.2.3.11)' ($merged.Count -eq 4)
    $complement = Get-Complement $allowed
    $total = [long]0
    foreach ($interval in $merged) { $total = $total + ($interval[1] - $interval[0] + 1) }
    foreach ($interval in $complement) { $total = $total + ($interval[1] - $interval[0] + 1) }
    & $check 'allowed plus blocked covers the whole IPv4 space exactly once' ($total -eq $space)
    & $check 'the first blocked range starts at 0.0.0.0' ((Format-Range $complement[0]).StartsWith('0.0.0.0-'))
    & $check 'the last blocked range ends at 255.255.255.255' ((Format-Range $complement[$complement.Count - 1]).EndsWith('-255.255.255.255'))
    $blockedStrings = @($complement | ForEach-Object { Format-Range $_ })
    & $check '10.0.0.5 is not inside any blocked range' (-not ($complement | Where-Object { $_[0] -le (ConvertTo-Number '10.0.0.5') -and $_[1] -ge (ConvertTo-Number '10.0.0.5') }))
    & $check '10.0.0.6 is inside a blocked range' ([bool]($complement | Where-Object { $_[0] -le (ConvertTo-Number '10.0.0.6') -and $_[1] -ge (ConvertTo-Number '10.0.0.6') }))
    & $check 'the ends of the space are handled (0.0.0.0 and 255.255.255.255 allowed)' ((Get-Complement @((ConvertTo-Interval '0.0.0.0'), (ConvertTo-Interval '255.255.255.255'))).Count -eq 1)
    & $check 'nothing is left to block when everything is allowed' ((Get-Complement @(, (ConvertTo-Interval '0.0.0.0/0'))).Count -eq 0)
    & $check 'a /24 is 256 addresses' ((ConvertTo-Interval '10.1.2.77/24')[1] - (ConvertTo-Interval '10.1.2.77/24')[0] + 1 -eq 256)
    & $check 'numbers round-trip' ((ConvertFrom-Number (ConvertTo-Number '172.31.255.1')) -eq '172.31.255.1')
    Write-Host ('{0} failure(s)' -f $script:failures)
    exit $(if ($script:failures -eq 0) { 0 } else { 1 })
}

if ($SelfTest) { Invoke-SelfTest }

function Remove-AgentRules {
    Get-NetFirewallRule -DisplayName ($RulePrefix + '-*') -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

if ($Remove) {
    Remove-AgentRules
    Unregister-ScheduledTask -TaskName $RefreshTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'firewall rules and refresh task removed'
    exit 0
}

if (-not (Test-Path -LiteralPath $AllowFile)) { throw ('Allow file not found: ' + $AllowFile) }
$sid = (New-Object System.Security.Principal.NTAccount($ServiceUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$allowed = New-Object System.Collections.ArrayList
$resolvedNames = @()
foreach ($line in (Get-Content -LiteralPath $AllowFile)) {
    $entry = $line.Trim()
    if ($entry -eq '' -or $entry.StartsWith('#')) { continue }
    if ($entry -match '^[0-9./-]+$') {
        [void]$allowed.Add((ConvertTo-Interval $entry))
        continue
    }
    try {
        $addresses = @([System.Net.Dns]::GetHostAddresses($entry) | Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork })
    } catch {
        Write-Warning ('cannot resolve {0}: {1}' -f $entry, $_.Exception.Message)
        continue
    }
    foreach ($address in $addresses) { [void]$allowed.Add((ConvertTo-Interval $address.ToString())) }
    $resolvedNames += ('{0} -> {1}' -f $entry, (($addresses | ForEach-Object { $_.ToString() }) -join ', '))
}
# name resolution itself and the loopback health endpoint must keep working
foreach ($server in @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses })) { [void]$allowed.Add((ConvertTo-Interval $server)) }
[void]$allowed.Add((ConvertTo-Interval '127.0.0.0/8'))
if ($allowed.Count -le 1) { throw 'Nothing in the allow file could be used; refusing to install a rule set that blocks everything.' }

$blocked = Get-Complement @($allowed.ToArray())
$resolvedNames | ForEach-Object { Write-Host $_ }
Write-Host ('{0} allowed ranges, {1} blocked ranges' -f (Merge-Intervals @($allowed.ToArray())).Count, $blocked.Count)
if ($DryRun) { $blocked | ForEach-Object { Write-Host ('block ' + (Format-Range $_)) }; exit 0 }

$descriptor = 'D:(A;;CC;;;{0})' -f $sid
Remove-AgentRules
$chunk = 100
for ($i = 0; $i -lt $blocked.Count; $i += $chunk) {
    $slice = @($blocked[$i..([Math]::Min($i + $chunk, $blocked.Count) - 1)] | ForEach-Object { Format-Range $_ })
    New-NetFirewallRule -DisplayName ('{0}-Block-IPv4-{1}' -f $RulePrefix, ($i / $chunk)) -Direction Outbound -Action Block -Profile Any -LocalUser $descriptor -RemoteAddress $slice -Description 'SomeWork agent: outbound to anything not in firewall-allow.txt' | Out-Null
}
New-NetFirewallRule -DisplayName ($RulePrefix + '-Block-IPv6') -Direction Outbound -Action Block -Profile Any -LocalUser $descriptor -RemoteAddress @('::/1', '8000::/1') -Description 'SomeWork agent: no IPv6' | Out-Null
Write-Host ('rules installed for {0} ({1})' -f $ServiceUser, $sid)

if ($RegisterRefreshTask) {
    $self = $MyInvocation.MyCommand.Path
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -AllowFile "{1}" -ServiceUser "{2}"' -f $self, $AllowFile, $ServiceUser
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
    Unregister-ScheduledTask -TaskName $RefreshTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $RefreshTaskName -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Description 'Re-resolves the agent allow-list host names' | Out-Null
    Write-Host ('refresh task {0} registered (every 30 minutes)' -f $RefreshTaskName)
}
