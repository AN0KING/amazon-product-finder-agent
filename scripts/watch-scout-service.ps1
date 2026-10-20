param(
  [switch]$Once,
  [ValidateRange(5, 3600)][int]$IntervalSeconds = 60
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverPath = Join-Path $projectRoot 'server.mjs'
$launcherPath = Join-Path $projectRoot 'launch-scout-au.ps1'
$logRoot = Join-Path $env:TEMP 'scout-au'
$pidFile = Join-Path $logRoot 'server.pid'
$watchdogPidFile = Join-Path $logRoot 'watchdog.pid'
$watchdogLog = Join-Path $logRoot 'watchdog.log'
$stopFile = Join-Path $projectRoot 'data\collection-watchdog.disabled'
$watchdogMutex = New-Object System.Threading.Mutex($false, 'Local\ScoutAmazonServiceWatchdog')
$ownsWatchdog = $false
. (Join-Path $projectRoot 'packaging\windows\Recovery.ps1')
$recoveryPath = Join-Path $logRoot 'watchdog-recovery.json'
$previousProbe = $null
$restartAttempts = @()
function Save-WatchdogRecovery {
  $temporary = $recoveryPath + '.' + $PID + '.tmp'
  @{ attempts=$restartAttempts; probe=$previousProbe } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $recoveryPath -Force
}


function Write-WatchdogEvent([string]$Message) {
  Add-Content -LiteralPath $watchdogLog -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString('o'), $Message)
}

function Get-ManagedScoutProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return Find-ScoutProcessByPath }
  $managedProcessId = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$managedProcessId)) { return Find-ScoutProcessByPath }
  $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $managedProcessId" -ErrorAction SilentlyContinue
  if (-not $managedProcess) { return Find-ScoutProcessByPath }
  if ($managedProcess.Name -ne 'node.exe' -or $managedProcess.CommandLine -notmatch ('(?:^|[\s"''])' + [regex]::Escape($serverPath) + '(?:$|[\s"''])')) {
    Write-WatchdogEvent 'Ignoring a stale PID owned by a different process; that process was not modified.'
    return Find-ScoutProcessByPath
  }
  return $managedProcess
}

function Find-ScoutProcessByPath {
  $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match ('(?:^|[\s"''])' + [regex]::Escape($serverPath) + '(?:$|[\s"''])') })
  if ($matches.Count -gt 1) { throw 'Multiple project processes found; recovery stopped.' }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

try {
  try { $ownsWatchdog = $watchdogMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsWatchdog = $true }
  if (-not $ownsWatchdog) { return }
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  Set-Content -LiteralPath $watchdogPidFile -Value $PID -NoNewline
  Write-WatchdogEvent "Started; interval ${IntervalSeconds}s."
  do {
    if (Test-Path -LiteralPath $stopFile) { break }
    try {
      if (Test-Path -LiteralPath $recoveryPath) {
        $savedRecovery = Get-Content -LiteralPath $recoveryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $previousProbe = $savedRecovery.probe
        $restartAttempts = @($savedRecovery.attempts)
      }
      $managedProcess = Get-ManagedScoutProcess
      $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
      if ($listeners.Count -and (-not $managedProcess -or @($listeners | Where-Object { $_.OwningProcess -ne $managedProcess.ProcessId }).Count)) {
        throw 'Port 4173 is occupied by an unverified process; it was not modified.'
      }
      $endpoint = 'http://127.0.0.1:4173/api/version'
      $probe = if ($managedProcess) { Get-ScoutWatchdogProbe $endpoint $previousProbe ([int]$managedProcess.ProcessId) } else { $null }
      $previousProbe = $probe
      Save-WatchdogRecovery
      if (-not $managedProcess -or $probe.action -ne 'none') {
        $restartAttempts = @($restartAttempts | Where-Object { $_ -and [DateTime]::Parse($_).ToUniversalTime() -gt [DateTime]::UtcNow.AddHours(-1) })
        if ($restartAttempts.Count -ge 5) { Write-WatchdogEvent 'Recovery cooldown: five service starts within one hour.' }
        elseif (-not (Test-Path -LiteralPath $stopFile)) {
          $confirmed = -not $managedProcess -or (Confirm-ScoutWatchdogRestart $endpoint $probe)
          if ($confirmed) {
            $freshProcess = Get-ManagedScoutProcess
            $freshListeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
            if ($managedProcess) {
              if (-not $freshProcess -or $freshProcess.ProcessId -ne $managedProcess.ProcessId -or @($freshListeners | Where-Object { $_.OwningProcess -ne $managedProcess.ProcessId }).Count) { throw 'Process ownership changed.' }
            } elseif ($freshProcess -or $freshListeners.Count) { throw 'Service appeared during recovery; no duplicate was started.' }
            if (Test-Path -LiteralPath $stopFile) { break }
            $restartAttempts += [DateTime]::UtcNow.ToString('o')
            Save-WatchdogRecovery
            if ($managedProcess) {
              Stop-Process -Id $managedProcess.ProcessId -Force -ErrorAction Stop
              Wait-Process -Id $managedProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
              if (Get-ManagedScoutProcess) { throw 'Previous service has not exited.' }
              Write-WatchdogEvent ('Recovering managed Scout: ' + $probe.action + '; run=' + $probe.runId)
            }
            if (Test-Path -LiteralPath $stopFile) { break }
            & $launcherPath -NoBrowser -NoWatchdog -Skip1688Startup
            $previousProbe = $null
            Save-WatchdogRecovery
            Write-WatchdogEvent 'Local service restored; saved tasks retain their pause and retry state.'
          }
        }
      }
    } catch {
      Write-WatchdogEvent ("Check failed: " + $_.Exception.Message)
    }
    if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
  } while (-not $Once)
} finally {
  if ($ownsWatchdog) {
    if ((Test-Path -LiteralPath $watchdogPidFile) -and (Get-Content -LiteralPath $watchdogPidFile -Raw).Trim() -eq [string]$PID) {
      Remove-Item -LiteralPath $watchdogPidFile -Force
    }
    $watchdogMutex.ReleaseMutex()
  }
  $watchdogMutex.Dispose()
}
