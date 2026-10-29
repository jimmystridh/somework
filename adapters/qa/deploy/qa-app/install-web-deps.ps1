# Installs the front end's packages with bun, and does not let one stalled attempt eat the whole time budget:
# an attempt that has not finished after AttemptSeconds is stopped and started again (bun resumes from its cache).
param(
    [Parameter(Mandatory = $true)][string]$WebRoot,
    [int]$AttemptSeconds = 900,
    [int]$Attempts = 3
)
$ErrorActionPreference = 'Stop'
$bun = 'C:\tools\bun\bun.exe'
for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $started = Get-Date
    $process = Start-Process -FilePath $bun -ArgumentList @('install', '--frozen-lockfile', '--cwd', ('"{0}"' -f $WebRoot)) -NoNewWindow -PassThru
    # without the handle, Windows PowerShell 5.1 reports an empty exit code for a process it did not wait for with -Wait
    $null = $process.Handle
    if ($process.WaitForExit($AttemptSeconds * 1000)) {
        if ($process.ExitCode -eq 0) {
            Write-Host ("bun install finished in {0:N0} s (attempt {1})" -f ((Get-Date) - $started).TotalSeconds, $attempt)
            exit 0
        }
        Write-Host ("bun install attempt {0} failed with exit {1}" -f $attempt, $process.ExitCode)
    } else {
        Write-Host ("bun install attempt {0} had not finished after {1} s, stopping it" -f $attempt, $AttemptSeconds)
        & taskkill.exe /PID $process.Id /T /F | Out-Null
    }
}
Write-Host ("bun install did not finish in {0} attempts" -f $Attempts)
exit 1
