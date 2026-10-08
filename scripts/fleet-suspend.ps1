# Stops (or starts again) the agent on a Windows machine of the fleet: its scheduled tasks, and everything a job left running.
#   fleet-suspend.ps1            stop and DISABLE the tasks (a deployment cannot start them again), end builds, browsers and the test stack
#   fleet-suspend.ps1 -Resume    enable the tasks and start the agent (the QA test stack starts itself on demand)
# Windows PowerShell 5.1, ASCII only.
[CmdletBinding()]
param([switch]$Resume)
$agentTasks = 'SomeWorkQa', 'SomeWorkWindowsDeveloper'
$stackTasks = 'QaAppServer', 'QaAppWeb'
foreach ($name in $agentTasks + $stackTasks) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { continue }
    if ($Resume) {
        Enable-ScheduledTask -TaskName $name | Out-Null
        if ($agentTasks -contains $name) { Start-ScheduledTask -TaskName $name }
    } else {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $name | Out-Null
    }
    '{0}: {1}' -f $name, (Get-ScheduledTask -TaskName $name).State
}
if (-not $Resume) {
    Start-Sleep -Seconds 5
    # what a verification or a build left behind (the SQL Server instance is not touched)
    Get-Process node, bun, msbuild, cl, link, msedge, ffmpeg-win64, Adm -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
    Start-Sleep -Seconds 3
    'processes left: ' + (@(Get-Process node, bun, msbuild, cl, msedge, Adm -ErrorAction SilentlyContinue).Count)
}
