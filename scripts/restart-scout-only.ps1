param([string]$NodePath = 'C:\Users\nanashiWu\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $projectRoot 'server.mjs'
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$origin = 'http://127.0.0.1:4173'
$state = (Invoke-RestMethod "$origin/api/version" -TimeoutSec 5).data
foreach ($field in @('activeSearchRequests', 'activeAmazonRequests', 'active1688Requests')) {
  if ($null -eq $state.$field -or [int]$state.$field -ne 0) { throw "Scout has active or unknown work ($field). No restart performed." }
}
if ($state.version -eq $expectedVersion) {
  [PSCustomObject]@{ version=$state.version; restarted=$false; reason='Already running expected version' } | ConvertTo-Json
  exit 0
}
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4173 -State Listen | Select-Object -First 1
if (-not $listener) { throw 'Scout listener was not found.' }
$oldProcessId = [int]$listener.OwningProcess
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $oldProcessId"
if ($processInfo.Name -ne 'node.exe' -or $processInfo.CommandLine -notmatch [regex]::Escape($serverPath)) {
  throw 'Port 4173 does not belong to this Scout server. Nothing stopped.'
}
if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Configured Node runtime is missing.' }
$logRoot = Join-Path $env:TEMP 'scout-au'
if (-not (Test-Path -LiteralPath $logRoot)) { New-Item -ItemType Directory -Path $logRoot | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutLog = Join-Path $logRoot "server-$expectedVersion-$stamp-output.log"
$stderrLog = Join-Path $logRoot "server-$expectedVersion-$stamp-error.log"

# Drain rejects a request if work started after the initial check; do not kill it.
$drain = Invoke-RestMethod "$origin/api/runtime/drain" -Method Post -Headers @{Origin=$origin} -TimeoutSec 5
if ($drain.ok -ne $true -or $drain.data.draining -ne $true) { throw 'Scout did not confirm idle drain mode.' }
$sealed = (Invoke-RestMethod "$origin/api/version" -TimeoutSec 5).data
if (-not $sealed.draining -or $sealed.activeSearchRequests -ne 0 -or $sealed.activeAmazonRequests -ne 0 -or $sealed.active1688Requests -ne 0) {
  throw 'Scout no longer confirms an idle restart. Nothing stopped.'
}
Stop-Process -Id $oldProcessId -ErrorAction Stop
Wait-Process -Id $oldProcessId -Timeout 5 -ErrorAction SilentlyContinue
$newProcess = Start-Process -FilePath $NodePath -ArgumentList @($serverPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Set-Content -LiteralPath (Join-Path $logRoot 'server.pid') -Value $newProcess.Id -NoNewline
for ($attempt=0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $ready = (Invoke-RestMethod "$origin/api/version" -TimeoutSec 2).data
    if ($ready.version -eq $expectedVersion) {
      [PSCustomObject]@{ version=$ready.version; restarted=$true; previousVersion=$state.version; previousProcessId=$oldProcessId; processId=$newProcess.Id; activeSearchRequests=$ready.activeSearchRequests; activeAmazonRequests=$ready.activeAmazonRequests; active1688Requests=$ready.active1688Requests; stdoutLog=$stdoutLog; stderrLog=$stderrLog; procurementServiceTouched=$false } | ConvertTo-Json
      exit 0
    }
  } catch {}
  if ($newProcess.HasExited) { break }
}
throw "Scout failed to become ready. Review $stderrLog and the recorded code rollback point."
