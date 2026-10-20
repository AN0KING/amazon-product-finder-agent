param([string]$InstallRoot, [switch]$Once)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Recovery.ps1')
$installDirectory = Get-InstallRoot $InstallRoot
$installation = Read-Installation $installDirectory
$enabledPath = Join-Path $installDirectory 'control\enabled'
if (-not (Test-Path -LiteralPath $enabledPath)) { exit 0 }
$mutex = New-Object Threading.Mutex($false, ('Local\ScoutAmazonSupervisor-' + (Get-InstanceKey $installDirectory)))
$ownedMutex = $false
try {
  try { $ownedMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownedMutex = $true }
  if (-not $ownedMutex) { exit 0 }
  Set-InstallationEnvironment $installDirectory
  $nodeRuntimePath = Resolve-NodeRuntime $installation.nodePath
  $attempts = @{}
  $probes = @{}
  $recoveryPath = Join-Path $installDirectory 'logs\supervisor-recovery.json'
  if (Test-Path -LiteralPath $recoveryPath) {
    $savedRecovery = Get-Content -LiteralPath $recoveryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $savedRecovery.attempts.PSObject.Properties) { $attempts[$property.Name] = @($property.Value) }
    foreach ($property in $savedRecovery.probes.PSObject.Properties) { $probes[$property.Name] = $property.Value }
  }
  $lastStates = @{}
  $statusPath = Join-Path $installDirectory 'logs\supervisor-status.json'
  $logPath = Join-Path $installDirectory 'logs\supervisor.log'
  $services = Get-ServiceDefinitions $installDirectory
  while (Test-Path -LiteralPath $enabledPath) {
    $states = @()
    foreach ($service in $services) {
      $state = 'unknown'
      $restart = $false
      $probe = $null
      $failure = $null
      try {
        $listeners = @(Get-PortListeners $service.port)
        $owned = @(Get-OwnedServiceProcesses $installDirectory $service.path)
        if ($listeners.Count) {
          $foreign = @($listeners | Where-Object { $_ -notin @($owned | ForEach-Object { [int]$_.ProcessId }) })
          if ($foreign.Count) { $state = 'foreign_port_owner' }
          else {
            if ($service.name -eq 'scout' -and $owned.Count -eq 1) {
              $probe = Get-ScoutWatchdogProbe $service.endpoint $probes[$service.name] ([int]$owned[0].ProcessId)
              $probes[$service.name] = $probe
              $state = $probe.status
              $restart = $probe.action -ne 'none'
            } else { try {
              $response = Invoke-RestMethod -Uri $service.endpoint -Method Get -TimeoutSec 5
              $valid = ($response.ok -eq $true)
              if ($service.name -eq 'bridge') { $valid = $valid -and ($response.product -eq '1688-procurement-assistant') }
              else { $valid = $valid -and [bool]$response.data.version }
              if ($valid) { $state = 'running' } else { $state = 'invalid_runtime_response' }
            } catch { $state = 'not_responding_no_forced_restart' } }
          }
        } elseif ($owned.Count) {
          $state = 'starting_or_unresponsive_no_duplicate'
          if ($service.name -eq 'scout' -and $owned.Count -eq 1) {
            $probe = Get-ScoutWatchdogProbe $service.endpoint $probes[$service.name] ([int]$owned[0].ProcessId)
            $probes[$service.name] = $probe
            $restart = $probe.action -eq 'restart_unresponsive'
          }
        }
        if (-not (Test-Path -LiteralPath $enabledPath)) { $state = 'stopped_by_user'; $restart = $false }
        elseif ($restart -or (-not $listeners.Count -and -not $owned.Count)) {
          $cutoff = [DateTime]::UtcNow.AddHours(-1)
          $recent = @($attempts[$service.name] | Where-Object { $_ -and [DateTime]::Parse($_).ToUniversalTime() -gt $cutoff })
          if ($recent.Count -ge 5) { $state = 'restart_limit_reached' }
          else {
            if ($restart) {
              if (-not (Confirm-ScoutWatchdogRestart $service.endpoint $probe)) { $state='recovery_cancelled_state_changed'; throw 'Task changed before recovery.' }
              $freshOwned = @(Get-OwnedServiceProcesses $installDirectory $service.path)
              $freshListeners = @(Get-PortListeners $service.port)
              if ($freshOwned.Count -ne 1 -or [int]$freshOwned[0].ProcessId -ne $probe.processId -or @($freshListeners | Where-Object { $_ -ne $probe.processId }).Count) { throw 'Process ownership changed.' }
            }
            if (-not (Test-Path -LiteralPath $enabledPath)) { $state='stopped_by_user'; throw 'Recovery disabled.' }
            $attempts[$service.name] = @($recent) + @([DateTime]::UtcNow.ToString('o'))
            Write-JsonAtomic $recoveryPath @{ attempts=$attempts; probes=$probes }
            if ($restart) {
              Stop-Process -Id $probe.processId -Force -ErrorAction Stop
              Wait-Process -Id $probe.processId -Timeout 10 -ErrorAction SilentlyContinue
            }
            if (-not (Test-Path -LiteralPath $enabledPath)) { $state='stopped_by_user'; throw 'Recovery disabled.' }
            if (@(Get-PortListeners $service.port).Count -or @(Get-OwnedServiceProcesses $installDirectory $service.path).Count) { throw 'Service present during recovery; no duplicate was started.' }
            $nodePath = $nodeRuntimePath
            if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $service.path -PathType Leaf)) { throw 'Installation files missing.' }
            $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
            $child = Start-Process -FilePath $nodePath -ArgumentList @('"' + $service.path + '"') -WorkingDirectory (Split-Path -Parent $service.path) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $installDirectory ('logs\' + $service.name + '-' + $stamp + '.out.log')) -RedirectStandardError (Join-Path $installDirectory ('logs\' + $service.name + '-' + $stamp + '.err.log'))
            $state = if ($restart) { 'restarted_' + $(if ($probe.action -eq 'restart_stalled') {'stalled'} else {'unresponsive'}) + '_from_saved_state' } else { 'started_from_saved_state' }
            $probes.Remove($service.name)
          }
        }
      } catch {
        $failure = $_.Exception.Message
        if ($state -notin @('recovery_cancelled_state_changed','stopped_by_user')) { $state = 'inspection_or_start_failed' }
      }
      $states += @{ name=$service.name; status=$state; port=$service.port; error=$failure }
      if ($lastStates[$service.name] -ne $state) {
        Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ([DateTime]::UtcNow.ToString('o') + ' ' + $service.name + ' ' + $state)
        $lastStates[$service.name] = $state
      }
    }
    Write-JsonAtomic $recoveryPath @{ attempts=$attempts; probes=$probes }
    Write-JsonAtomic $statusPath @{ checkedAt=[DateTime]::UtcNow.ToString('o'); processId=$PID; intervalSeconds=60; services=$states }
    if ($Once) { break }
    for ($tick=0; $tick -lt 60 -and (Test-Path -LiteralPath $enabledPath); $tick++) { Start-Sleep -Seconds 1 }
  }
} finally {
  if ($ownedMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
