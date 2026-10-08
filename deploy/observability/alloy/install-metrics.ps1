<#
.SYNOPSIS
  Adds the metrics block to this Windows machine's Alloy configuration: the machine's own metrics and the agent's /metrics, pushed to the central
  Prometheus through the ingest proxy with the same write account, password and CA as the logs. PowerShell 5.1 compatible, idempotent (the block between
  the markers is replaced), validated, and the previous file comes back when Alloy does not stay up. Run as an administrator.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-metrics.ps1 -Target 'windows-developer=10.10.10.45:8081'
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,40}=[A-Za-z0-9.-]+:[0-9]{2,5}$')][string[]]$Target = @(),
    [string]$ConfigDir = 'C:\ProgramData\AgentClusterObservability',
    [string]$Alloy = 'C:\Program Files\GrafanaLabs\Alloy\alloy-windows-amd64.exe',
    [int]$SettleSeconds = 15
)
$ErrorActionPreference = 'Stop'
$config = Join-Path $ConfigDir 'config.alloy'
$begin = '// begin metrics (install-metrics.ps1)'
$end = '// end metrics'
$text = Get-Content -LiteralPath $config -Raw

function First([string]$Pattern) {
    $m = [regex]::Match($text, $Pattern)
    if (-not $m.Success) { throw "cannot read $Pattern from $config" }
    return $m.Groups[1].Value
}
$username = First 'username\s*=\s*"([^"]*)"'
$hostLabel = First 'host\s*=\s*"([^"]*)"'
$vmId = First 'vm_id\s*=\s*"([^"]*)"'
$passwordFile = First 'password_file\s*=\s*"([^"]*)"'
$caFile = First 'ca_file\s*=\s*"([^"]*)"'

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add($begin)
$lines.Add('prometheus.remote_write "central" {')
$lines.Add('  endpoint {')
$lines.Add('    url = "https://10.10.10.13:9443/api/v1/write"')
$lines.Add('    basic_auth {')
$lines.Add(('      username = "{0}"' -f $username))
$lines.Add(('      password_file = "{0}"' -f $passwordFile))
$lines.Add('    }')
$lines.Add(('    tls_config {{ ca_file = "{0}" }}' -f $caFile))
$lines.Add('  }')
$lines.Add(('  external_labels = {{ cluster = "agent-cluster", host = "{0}", vm_id = "{1}", os = "windows" }}' -f $hostLabel, $vmId))
$lines.Add('}')
$lines.Add('prometheus.exporter.windows "node" {')
$lines.Add('  enabled_collectors = ["cpu", "cs", "logical_disk", "memory", "net", "os", "system"]')
$lines.Add('}')
$lines.Add('prometheus.scrape "node" {')
$lines.Add('  job_name = "node"')
$lines.Add('  targets = prometheus.exporter.windows.node.targets')
$lines.Add('  scrape_interval = "30s"')
$lines.Add('  forward_to = [prometheus.remote_write.central.receiver]')
$lines.Add('}')
if ($Target.Count -gt 0) {
    $lines.Add('prometheus.scrape "agents" {')
    $lines.Add('  job_name = "somework-agent"')
    $lines.Add('  targets = [')
    foreach ($pair in $Target) {
        $name, $address = $pair.Split('=', 2)
        $lines.Add(('    {{ __address__ = "{0}", stack = "{1}" }},' -f $address, $name))
    }
    $lines.Add('  ]')
    $lines.Add('  scrape_interval = "30s"')
    $lines.Add('  forward_to = [prometheus.remote_write.central.receiver]')
    $lines.Add('}')
}
$lines.Add($end)

$backup = "$config.before-metrics-$(Get-Date -Format yyyyMMddHHmmss)"
Copy-Item -LiteralPath $config -Destination $backup
$existing = [regex]::Replace($text, '(?s)\r?\n?' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end), '')
$new = $existing.TrimEnd() + "`r`n" + ($lines -join "`r`n") + "`r`n"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($config, $new, $utf8)

function Restore([string]$Why) {
    Copy-Item -LiteralPath $backup -Destination $config -Force
    Restart-Service -Name 'Alloy' -ErrorAction SilentlyContinue
    throw "$Why; the previous configuration is back"
}
if (Test-Path -LiteralPath $Alloy) {
    $ErrorActionPreference = 'Continue'
    & $Alloy validate $config 2>&1 | Out-Null
    $validated = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($validated -ne 0) { Restore 'the new configuration did not validate' }
}
Restart-Service -Name 'Alloy'
Start-Sleep -Seconds $SettleSeconds
if ((Get-Service -Name 'Alloy').Status -ne 'Running') { Restore 'Alloy did not stay up with the metrics block' }
Write-Output ('metrics block installed for {0} ({1}); previous configuration kept as {2}' -f $hostLabel, $vmId, $backup)
