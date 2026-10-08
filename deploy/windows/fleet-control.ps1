# The only thing the manager's ssh key may run on a Windows agent machine (administrators_authorized_keys: command="powershell.exe -NoProfile -ExecutionPolicy Bypass
# -File C:\somework\bin\fleet-control.ps1",restrict,from="<agents VM>"), and what scripts/fleet-suspend.sh runs. Exactly one word is accepted:
#   suspend   stop the agent and the QA test stack, disable their scheduled tasks (a deployment cannot start them again), end what a job left running
#   resume    enable the tasks and start the agent (the QA test stack starts itself on demand)
# Install on the machine by hand, like the deployment wrapper: a key that could replace this file could run anything. Windows PowerShell 5.1, ASCII only.
param([string]$Action)
$ErrorActionPreference = 'Stop'
if (-not $Action) { $Action = $env:SSH_ORIGINAL_COMMAND }
$Action = ([string]$Action).Trim()
if ($Action -notin 'suspend', 'resume') { [Console]::Error.WriteLine("only 'suspend' or 'resume' is allowed"); exit 2 }
$agentTasks = 'SomeWorkQa', 'SomeWorkWindowsDeveloper'
$stackTasks = 'QaAppServer', 'QaAppWeb'
foreach ($name in $agentTasks + $stackTasks) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { continue }
    if ($Action -eq 'resume') {
        Enable-ScheduledTask -TaskName $name | Out-Null
        if ($agentTasks -contains $name) { Start-ScheduledTask -TaskName $name }
    } else {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $name | Out-Null
    }
    '{0}: {1}' -f $name, (Get-ScheduledTask -TaskName $name).State
}
if ($Action -eq 'suspend') {
    Start-Sleep -Seconds 5
    # what a verification or a build left behind (the SQL Server instance is not touched)
    Get-Process node, bun, msbuild, cl, link, msedge, ffmpeg-win64, Adm -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
    Start-Sleep -Seconds 3
    'processes left: ' + (@(Get-Process node, bun, msbuild, cl, msedge, Adm -ErrorAction SilentlyContinue).Count)
}
