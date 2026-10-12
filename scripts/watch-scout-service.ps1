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
$unhealthyChecks = 0

function Write-WatchdogEvent([string]$Message) {
  Add-Content -LiteralPath $watchdogLog -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString('o'), $Message)
}

function Get-ManagedScoutProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $managedProcessId = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$managedProcessId)) { return $null }
  $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $managedProcessId" -ErrorAction SilentlyContinue
  if (-not $managedProcess) { return $null }
  if ($managedProcess.Name -ne 'node.exe' -or $managedProcess.CommandLine -notmatch [regex]::Escape($serverPath)) {
    Write-WatchdogEvent 'Ignoring a stale PID owned by a different process; that process was not modified.'
    return $null
  }
  return $managedProcess
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
      $healthy = $false
      try {
        $runtime = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/version' -TimeoutSec 5
        $healthy = $runtime.ok -eq $true -and $null -ne $runtime.data.version
      } catch {}
      if ($healthy) {
        $unhealthyChecks = 0
      } else {
        $unhealthyChecks += 1
        $managedProcess = Get-ManagedScoutProcess
        if (-not $managedProcess -or $unhealthyChecks -ge 3) {
          if ($managedProcess) {
            # Only a verified Scout process that failed three independent checks
            # can be restarted. The background queue is durable on disk.
            Stop-Process -Id $managedProcess.ProcessId -Force -ErrorAction Stop
            Write-WatchdogEvent 'Restarting an unresponsive managed Scout process after three checks.'
          } else {
            $otherListener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
            if ($otherListener) { throw 'Port 4173 is occupied by an unverified process; it was not modified.' }
            Write-WatchdogEvent 'Scout process is absent; restoring the local service.'
          }
          & $launcherPath -NoBrowser -NoWatchdog -Skip1688Startup
          $unhealthyChecks = 0
          Write-WatchdogEvent 'Local service restored; its saved background task will resume automatically.'
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
