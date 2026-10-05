# Supervisor of the QA agent. The scheduled task starts this as the service user at boot. It loads agent.env, starts the
# agent with node, restarts it when it exits (with a growing pause when it keeps failing), and keeps the log files tidy.
# Stop it with `Stop-ScheduledTask` (ends the whole process tree) or by creating <InstallRoot>\STOP and ending the task.
# Windows PowerShell 5.1 compatible, ASCII only.
[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\somework\agent',
    [string]$LogRoot = 'C:\somework\logs',
    [string]$EnvFile = ''
)
$ErrorActionPreference = 'Stop'
if (-not $EnvFile) { $EnvFile = Join-Path $InstallRoot 'agent.env' }

function Import-EnvFile([string]$Path) {
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $text = $line.Trim()
        if ($text -eq '' -or $text.StartsWith('#')) { continue }
        $index = $text.IndexOf('=')
        if ($index -lt 1) { throw ('Bad line in {0}: {1}' -f $Path, $text) }
        $name = $text.Substring(0, $index).Trim()
        $value = $text.Substring($index + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) { $value = $value.Substring(1, $value.Length - 2) }
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Write-Supervisor([string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
    Add-Content -LiteralPath (Join-Path $LogRoot 'supervisor.log') -Value $line
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$stopFile = Join-Path $InstallRoot 'STOP'
$appDirectory = Join-Path $InstallRoot 'adapters\qa'
$failures = 0

while ($true) {
    if (Test-Path -LiteralPath $stopFile) { Write-Supervisor 'STOP file present; supervisor exits'; break }

    # logs older than two weeks go; the agent's own JSON log lines (stderr) and stdout are separate files per run
    Get-ChildItem -LiteralPath $LogRoot -Filter 'agent-*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue

    Import-EnvFile $EnvFile
    $node = $env:NODE_EXE
    if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
    $env:NODE_OPTIONS = '--disable-warning=ExperimentalWarning'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $standardOutput = Join-Path $LogRoot ('agent-{0}.out.log' -f $stamp)
    $standardError = Join-Path $LogRoot ('agent-{0}.jsonl' -f $stamp)

    $started = Get-Date
    Write-Supervisor ('starting {0} src\main.ts (log {1})' -f $node, $standardError)
    $process = Start-Process -FilePath $node -ArgumentList @('src\main.ts') -WorkingDirectory $appDirectory -NoNewWindow -PassThru -RedirectStandardOutput $standardOutput -RedirectStandardError $standardError
    $null = $process.Handle   # keeps the handle so ExitCode is available after the process ends
    $process.WaitForExit()
    $ranSeconds = ((Get-Date) - $started).TotalSeconds
    Write-Supervisor ('agent exited with code {0} after {1} s' -f $process.ExitCode, [int]$ranSeconds)

    if ($ranSeconds -gt 300) { $failures = 0 } else { $failures = $failures + 1 }
    $pause = [Math]::Min(60, [Math]::Pow(2, $failures))
    Start-Sleep -Seconds ([int]$pause)
}
