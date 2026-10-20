# Passive probes shared by the installed supervisor and source launcher watchdog.
function Get-ScoutWatchdogFingerprint($Job) {
  Set-StrictMode -Off
  return (@($Job.runId, $Job.lastProgressAt, $Job.phase, $Job.discoveryCursor,
    $Job.counts.processed, $Job.counts.pending) -join '|')
}

function Test-ScoutWatchdogRunnable($Runtime, $Job) {
  Set-StrictMode -Off
  if (-not $Job -or -not $Job.runId -or $Job.enabled -ne $true -or $Job.archivedAt) { return $false }
  if ($Job.status -notin @('queued','running','cooldown') -or $Job.supplierPause -or $Job.targetedRetry) { return $false }
  if ($Job.causeCode -and $Job.causeCode -notin @('COLLECTION_TIMEOUT','COLLECTION_REQUEST_FAILED','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','AMAZON_FETCH_TIMEOUT','AMAZON_FETCH_REQUEST_FAILED','AMAZON_REQUEST_FAILED','EDGE_CDP_CLOSED','EDGE_CDP_CONNECT_TIMEOUT')) { return $false }
  if ($Runtime.draining -or $Runtime.active1688Requests -ne 0 -or $null -eq $Runtime.activeAmazonRequests -or
    $null -eq $Runtime.activeSearchRequests -or $Runtime.activeSearchRequests -gt $Runtime.activeAmazonRequests) { return $false }
  if ($Job.workerActive -ne $true -and $Runtime.activeAmazonRequests -ne 0) { return $false }
  if ($Job.nextRetryAt -and [DateTime]::Parse($Job.nextRetryAt).ToUniversalTime() -gt [DateTime]::UtcNow) { return $false }
  return $Job.discoveryComplete -ne $true -or $Job.counts.pending -gt 0
}

function Get-ScoutWatchdogProbe([string]$Endpoint, $Previous, [int]$ProcessId) {
  # Old snapshots and first probes legitimately omit optional fields.
  Set-StrictMode -Off
  $now = [DateTime]::UtcNow
  $probe = @{ processId=$ProcessId; failures=0; action='none'; status='running'; checkedAt=$now.ToString('o') }
  try {
    $response = Invoke-RestMethod -Uri $Endpoint -Method Get -TimeoutSec 5
    if ($response.ok -ne $true -or -not $response.data.version) { throw 'Invalid Scout version response.' }
    $runtime = $response.data
  } catch {
    $probe.failures = 1
    if ($Previous.processId -eq $ProcessId) { $probe.failures += [int]$Previous.failures }
    $probe.status = 'unresponsive_observing'
    if ($probe.failures -ge 3) { $probe.action='restart_unresponsive' }
    return $probe
  }
  try {
    $collection = Invoke-RestMethod -Uri ($Endpoint -replace '/api/version$', '/api/amazon/collection') -Method Get -TimeoutSec 5
    if ($collection.ok -ne $true) { throw 'Invalid collection response.' }
    $job = $collection.data
    if (-not (Test-ScoutWatchdogRunnable $runtime $job)) { return $probe }
    $pipeline = Invoke-RestMethod -Uri ($Endpoint -replace '/api/version$', '/api/1688/pipeline') -Method Get -TimeoutSec 5
    if ($pipeline.ok -ne $true) { throw 'Invalid supplier pipeline response.' }
    if ($pipeline.data -and $pipeline.data.status -in @('running','queued','cooldown')) { return $probe }
    $probe.fingerprint = Get-ScoutWatchdogFingerprint $job
    $probe.runId = $job.runId
    $probe.revision = $job.revision
    $probe.observedSince = $now.ToString('o')
    if ($Previous.processId -eq $ProcessId -and $Previous.fingerprint -eq $probe.fingerprint -and $Previous.observedSince) {
      $probe.observedSince = $Previous.observedSince
      if (($now - [DateTime]::Parse($probe.observedSince).ToUniversalTime()).TotalMinutes -ge 15) {
        $probe.action='restart_stalled'; $probe.status='collection_stalled'
      }
    }
  } catch { $probe.status='collection_inspection_failed' }
  return $probe
}

function Confirm-ScoutWatchdogRestart([string]$Endpoint, $Probe) {
  # A second probe must still support the decision; a new pause/progress wins.
  $fresh = Get-ScoutWatchdogProbe $Endpoint $Probe $Probe.processId
  if ($fresh.action -ne $Probe.action) { return $false }
  if ($Probe.action -eq 'restart_stalled') {
    return $fresh.runId -eq $Probe.runId -and $fresh.revision -eq $Probe.revision -and $fresh.fingerprint -eq $Probe.fingerprint
  }
  return $Probe.action -eq 'restart_unresponsive'
}
