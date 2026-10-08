param(
  [switch]$ForceRestart,
  [switch]$NoBrowser,
  [switch]$KeepServiceAlive,
  [switch]$NoWatchdog
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $projectRoot "server.mjs"
$appOrigin = "http://127.0.0.1:4173"
$appUri = "$appOrigin/"
$versionUri = "http://127.0.0.1:4173/api/version"
$expectedVersion = "0.9.39"
$logRoot = Join-Path $env:TEMP "scout-au"
$stdoutLog = Join-Path $logRoot "server-output.log"
$stderrLog = Join-Path $logRoot "server-error.log"
$pidFile = Join-Path $logRoot "server.pid"

function Start-ScoutWatchdog {
  if ($NoWatchdog) { return }
  $watchdogScript = Join-Path $projectRoot 'scripts\watch-scout-service.ps1'
  $watchdogPidFile = Join-Path $logRoot 'watchdog.pid'
  if (Test-Path -LiteralPath (Join-Path $projectRoot 'data\collection-watchdog.disabled')) { return }
  if (Test-Path -LiteralPath $watchdogPidFile) {
    $watchdogProcessId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $watchdogPidFile -Raw).Trim(), [ref]$watchdogProcessId)) {
      $watchdogProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $watchdogProcessId" -ErrorAction SilentlyContinue
      if ($watchdogProcess -and $watchdogProcess.CommandLine -match [regex]::Escape($watchdogScript)) { return }
    }
  }
  $watchdogShellPath = (Get-Process -Id $PID -ErrorAction Stop).Path
  Start-Process -FilePath $watchdogShellPath `
    -ArgumentList @('-NoProfile', '-File', ('"' + $watchdogScript + '"')) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
}

function Get-ScoutVersionInfo {
  try {
    $response = Invoke-RestMethod -Uri $versionUri -Method Get -TimeoutSec 3
    if ($response.ok -eq $true) {
      return $response.data
    }
  } catch {}
  return $null
}

function Test-ScoutService {
  try {
    $response = Invoke-WebRequest -Uri $appUri -Method Get -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch "PRODUCT AGENT") {
      return $false
    }
    $versionInfo = Get-ScoutVersionInfo
    return $null -ne $versionInfo -and $versionInfo.version -eq $expectedVersion
  } catch {
    return $false
  }
}

function Test-ScoutPage {
  try {
    $response = Invoke-WebRequest -Uri $appUri -Method Get -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200 -and $response.Content -match "PRODUCT AGENT"
  } catch {
    return $false
  }
}

function Get-ScoutListenerProcessId {
  $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    return [int]$listener.OwningProcess
  }

  foreach ($line in (& netstat.exe -ano -p TCP 2>$null)) {
    if ($line -match '^\s*TCP\s+127\.0\.0\.1:4173\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      return [int]$Matches[1]
    }
  }
  return $null
}

function Stop-OutdatedScoutService {
  if (-not (Test-ScoutPage)) {
    return
  }
  $listenerProcessId = Get-ScoutListenerProcessId
  if ($null -eq $listenerProcessId) {
    throw "An outdated Scout page is running, but its local process could not be identified."
  }
  if (-not (Test-Path -LiteralPath $pidFile)) {
    throw "The outdated Scout service is not managed by this launcher. Close it before retrying."
  }
  $managedPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$managedPid)) {
    throw "The Scout process record is invalid; the service was not stopped."
  }
  if ($managedPid -ne $listenerProcessId) {
    throw "The listener on port 4173 does not match the managed Scout process."
  }
  $listenerProcess = Get-Process -Id $listenerProcessId -ErrorAction Stop
  if ($listenerProcess.ProcessName -ne "node") {
    throw "Port 4173 is owned by a non-Scout process."
  }
  $processInfo = $null
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($listenerProcess.Id)" -ErrorAction Stop
  } catch {}
  if ($processInfo) {
    $normalizedServerPath = [regex]::Escape($serverPath)
    if ($processInfo.CommandLine -notmatch $normalizedServerPath) {
      throw "The Node listener on port 4173 is not this Scout service."
    }
  } elseif (-not [string]::IsNullOrWhiteSpace($listenerProcess.Path)) {
    $expectedNodePath = [System.IO.Path]::GetFullPath((Get-Command node -ErrorAction Stop).Source)
    $listenerNodePath = [System.IO.Path]::GetFullPath($listenerProcess.Path)
    if (-not [string]::Equals($listenerNodePath, $expectedNodePath, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The listener on port 4173 is not using the expected Node runtime."
    }
  }
  $versionInfo = Get-ScoutVersionInfo
  if ($null -eq $versionInfo) {
    throw "The outdated Scout runtime state could not be verified."
  }
  if ([int]$versionInfo.activeSearchRequests -gt 0) {
    throw "The outdated Scout service still has an active analysis task."
  }
  try {
    $drainResponse = Invoke-RestMethod -Uri "$appOrigin/api/runtime/drain" -Method Post -Headers @{ Origin = $appOrigin } -TimeoutSec 5
  } catch {
    throw "The outdated Scout service did not confirm a safe restart."
  }
  if ($drainResponse.ok -ne $true -or $drainResponse.data.draining -ne $true) {
    throw "The outdated Scout service did not enter drain mode."
  }
  Stop-Process -Id $listenerProcess.Id -Force
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)) {
      return
    }
  }
  throw "The outdated Scout service did not stop."
}

if (-not (Test-Path -LiteralPath $logRoot)) {
  New-Item -ItemType Directory -Path $logRoot | Out-Null
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
if ($ForceRestart -or -not (Test-ScoutService)) {
  Stop-OutdatedScoutService
  # Scout starts independently; 1688 recovery remains an explicit in-app action.
  $scoutProcess = Start-Process -FilePath $nodePath `
    -ArgumentList @($serverPath) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
  Set-Content -LiteralPath $pidFile -Value $scoutProcess.Id -NoNewline

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-ScoutService) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    if ($NoBrowser) { throw "Scout could not start. Diagnostic log: $stderrLog" }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      "Scout Amazon Product Agent could not start.`n`nDiagnostic log: $stderrLog",
      "Scout Amazon",
      "OK",
      "Error"
    ) | Out-Null
    exit 1
  }
  if ($KeepServiceAlive) {
    Start-ScoutWatchdog
    $scoutProcess.WaitForExit()
    exit $scoutProcess.ExitCode
  }
}

Start-ScoutWatchdog

# Start the 1688 procurement assistant bridge alongside Scout (best-effort;
# the in-app 1688 flows can also start it on demand via /api/1688/service/recover).
try {
  $dependencyScript = Join-Path $projectRoot "scripts\start-1688-dependency.mjs"
  Start-Process -FilePath $nodePath `
    -ArgumentList @($dependencyScript) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden | Out-Null
} catch {}

if (-not $NoBrowser) {
  $edgeCandidates = @(
    [Environment]::GetFolderPath('ProgramFilesX86'),
    [Environment]::GetFolderPath('ProgramFiles'),
    [Environment]::GetFolderPath('LocalApplicationData')
  ) | Where-Object { $_ } | ForEach-Object {
    Join-Path $_ "Microsoft\Edge\Application\msedge.exe"
  }
  $edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $edgePath) {
    $edgePath = (Get-Command msedge -ErrorAction Stop).Source
  }

  Start-Process -FilePath $edgePath -ArgumentList @("--app=$appUri")
}
