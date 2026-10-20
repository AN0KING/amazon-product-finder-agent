param([string]$InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
$installDirectory = Get-InstallRoot $InstallRoot
$null = Read-Installation $installDirectory
$services = Get-ServiceDefinitions $installDirectory
function Assert-BridgeIdle($Response) {
  if ($Response.ok -ne $true -or $Response.product -ne '1688-procurement-assistant') { throw 'Cannot verify 1688 service identity.' }
  if ($Response.queue.running -gt 0 -or $Response.queue.waitingLogin -eq $true) { throw 'A 1688 request or login session is running. Wait for it to finish before stopping.' }
  if ($Response.queue.queued -gt 0 -and $Response.queue.ratePolicy.manualResumeRequired -ne $true) { throw '1688 has runnable queued tasks. Wait for completion or an explicit task pause before stopping.' }
}
$scoutOwned = $false
# Check ownership and work state before disabling recovery or stopping anything.
Assert-ServicePortsAvailable $installDirectory
foreach ($service in $services) {
  if (-not @(Get-OwnedServiceProcesses $installDirectory $service.path).Count) { continue }
  try { $response = Invoke-RestMethod -Uri $service.endpoint -Method Get -TimeoutSec 5 }
  catch { throw "Cannot verify idle state of $($service.name). No process was stopped." }
  if ($service.name -eq 'scout') {
    $scoutOwned = $true
    $version = $response.data
    if ($version.activeSearchRequests -gt 0 -or $version.activeAmazonRequests -gt 0 -or $version.active1688Requests -gt 0) { throw 'An active request is running. Pause work in the application, wait for it to settle, and retry.' }
    $collection = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/amazon/collection' -Method Get -TimeoutSec 5
    $pipeline = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/1688/pipeline' -Method Get -TimeoutSec 5
    foreach ($job in @($collection.data,$pipeline.data)) {
      if ($job -and $job.status -in @('running','queued','cooldown','retrying','starting','collecting','pending')) { throw 'A background task is active. Pause it in the application before stopping.' }
    }
  } else { Assert-BridgeIdle $response }
}
if ($scoutOwned) {
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/runtime/drain' -Method Post -Headers @{ Origin='http://127.0.0.1:4173' } -ContentType 'application/json' -Body '{}' -TimeoutSec 5
  $version = (Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/version' -Method Get -TimeoutSec 5).data
  if ($version.draining -ne $true -or $version.activeSearchRequests -gt 0 -or $version.activeAmazonRequests -gt 0 -or $version.active1688Requests -gt 0) { throw 'Service is not idle after draining. Nothing was stopped; draining expires automatically.' }
}
foreach ($service in $services) {
  if ($service.name -eq 'bridge' -and @(Get-OwnedServiceProcesses $installDirectory $service.path).Count) {
    Assert-BridgeIdle (Invoke-RestMethod -Uri $service.endpoint -Method Get -TimeoutSec 5)
  }
}
$enabledPath = Join-Path $installDirectory 'control\enabled'
if (Test-Path -LiteralPath $enabledPath) { Remove-Item -LiteralPath $enabledPath }
foreach ($process in (Get-OwnedSupervisorProcesses $installDirectory)) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
foreach ($service in $services) {
  foreach ($process in (Get-OwnedServiceProcesses $installDirectory $service.path)) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
}
Write-Output 'Stopped this installation. Saved tasks, manual data, configuration and login profiles remain intact.'
