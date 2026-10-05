<#
.SYNOPSIS
  Gives a Windows clone its own identity in the central log pipeline (Grafana Alloy -> Loki). PowerShell 5.1 compatible.

.DESCRIPTION
  A clone of the golden image ships its logs as the machine it was cloned from: the Alloy configuration carries a fixed host label, VM id and
  write account, and the write-ahead log and event bookmarks were copied while the original was running (so the clone logs "segments are not
  sequential" errors and replays old events that Loki rejects as too old). This script, run on the clone as an administrator:
    1. replaces the write account name, host label and VM id in the Alloy configuration,
    2. reads the new account's password from STANDARD INPUT (never an argument) and stores it where the configuration expects it,
    3. optionally adds a source for the agent's own JSON log files,
    4. stops Alloy, discards the copied write-ahead log, starts Alloy and checks that it stays up (the previous configuration is restored if not).
  The central side needs a matching write account first (one per client; see the observability notes). Idempotent.

.EXAMPLE
  ssh logs-host 'sudo cat /etc/.../writers/111' | ssh clone 'powershell -NoProfile -ExecutionPolicy Bypass -File set-log-identity.ps1 -HostLabel admin-cloud-windows-2 -VmId 111 -AgentLogService windows-developer'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9-]{0,62}$')][string]$HostLabel,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{1,6}$')][string]$VmId,
    # service_name label of the agent's own log files, e.g. windows-developer or qa; empty = do not ship them
    [ValidatePattern('^[a-z0-9-]{0,40}$')][string]$AgentLogService = '',
    [string]$AgentLogGlob = 'C:/somework/logs/agent-*.jsonl',
    [string]$ConfigDir = 'C:\ProgramData\AgentClusterObservability',
    [string]$AlloyData = 'C:\ProgramData\GrafanaLabs\Alloy\data'
)

$ErrorActionPreference = 'Stop'
$config = Join-Path $ConfigDir 'config.alloy'
$passwordFile = Join-Path $ConfigDir 'writer-password'
if (-not (Test-Path -LiteralPath $config)) { throw "no Alloy configuration at $config" }

$password = [Console]::In.ReadToEnd().Trim()
if ($password.Length -lt 20) { throw 'the writer password must be passed on standard input (at least 20 characters)' }

$backup = "$config.before-$(Get-Date -Format yyyyMMddHHmmss)"
Copy-Item -LiteralPath $config -Destination $backup

# 1. identity in the configuration
$text = Get-Content -LiteralPath $config -Raw
$text = [regex]::Replace($text, 'username\s*=\s*"[0-9]+"', ('username = "{0}"' -f $VmId))
$text = [regex]::Replace($text, 'host="[^"]*"', ('host="{0}"' -f $HostLabel))
$text = [regex]::Replace($text, 'vm_id="[^"]*"', ('vm_id="{0}"' -f $VmId))

# 3. the agent's own log files (added once, replaced if the service name changes)
$begin = '// begin agent logs (set-log-identity.ps1)'
$end = '// end agent logs'
$text = [regex]::Replace($text, '(?s)\r?\n' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end), '')
if ($AgentLogService) {
    $block = @(
        $begin,
        'local.file_match "agent" {',
        ('  path_targets = [{ __path__ = "' + $AgentLogGlob + '", cluster="agent-cluster", host="' + $HostLabel + '", vm_id="' + $VmId + '", os="windows", source="agent", service_name="' + $AgentLogService + '", level="info" }]'),
        '}',
        'loki.source.file "agent" {',
        '  targets = local.file_match.agent.targets',
        '  forward_to = [loki.process.safe.receiver]',
        '}',
        $end
    ) -join "`r`n"
    $text = $text.TrimEnd() + "`r`n" + $block + "`r`n"
}

# 2. the password (ACL as the original: Administrators and SYSTEM only)
$service = Get-Service -Name 'Alloy' -ErrorAction Stop
Stop-Service -Name 'Alloy' -Force
[IO.File]::WriteAllText($passwordFile, $password)
& icacls.exe $passwordFile /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null
Set-Content -LiteralPath $config -Value $text -NoNewline

# 4. discard the write-ahead log that was copied from the running original, then start and verify
$wal = Join-Path $AlloyData 'loki.write.central'
if (Test-Path -LiteralPath $wal) { Remove-Item -LiteralPath $wal -Recurse -Force }
Start-Service -Name 'Alloy'
Start-Sleep -Seconds 15
if ((Get-Service -Name 'Alloy').Status -ne 'Running') {
    Copy-Item -LiteralPath $backup -Destination $config -Force
    Start-Service -Name 'Alloy'
    throw 'Alloy did not stay up with the new configuration; the previous one was restored'
}
Write-Output ('log identity set: host={0} vm_id={1} account={1} agent-logs={2}; Alloy is running; previous config kept as {3}' -f $HostLabel, $VmId, $(if ($AgentLogService) { $AgentLogService } else { 'none' }), $backup)
