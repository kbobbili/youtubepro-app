# Registers the hourly SportsCenter NFL discovery task for the current user.
# Remove with: Unregister-ScheduledTask -TaskName 'SportsCenter NFL discovery' -Confirm:$false
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'scripts\run-hourly.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddHours((Get-Date).Hour + 1)) -RepetitionInterval (New-TimeSpan -Hours 1)
# Missed runs (laptop asleep) start as soon as possible; never run two instances at once.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SportsCenter NFL discovery' -Action $action -Trigger $trigger -Settings $settings -Description 'Hourly prospective NFL highlight discovery (SportsCenter validation experiment)' -Force | Out-Null
Get-ScheduledTask -TaskName 'SportsCenter NFL discovery' | Select-Object TaskName, State
