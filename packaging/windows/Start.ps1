param([string]$InstallRoot, [switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'Common.ps1')
$installDirectory = Get-InstallRoot $InstallRoot
$installation = Read-Installation $installDirectory
$null = Resolve-NodeRuntime $installation.nodePath
Assert-ServicePortsAvailable $installDirectory
[IO.File]::WriteAllText((Join-Path $installDirectory 'control\enabled'), [DateTime]::UtcNow.ToString('o'))
$supervisorPath = Join-Path $installDirectory 'control\scripts\Supervisor.ps1'
Start-Process -FilePath (Get-SystemPowerShell) -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $supervisorPath + '"'),'-InstallRoot',('"' + $installDirectory + '"')) -WorkingDirectory $installDirectory -WindowStyle Hidden | Out-Null
if (-not $NoBrowser) {
  $ready = $false
  for ($attempt=0; $attempt -lt 20; $attempt++) {
    $scout = @(Get-ServiceDefinitions $installDirectory | Where-Object { $_.name -eq 'scout' })[0]
    $owned = @(Get-OwnedServiceProcesses $installDirectory $scout.path)
    if ($owned.Count) {
      try { $response = Invoke-RestMethod -Uri $scout.endpoint -Method Get -TimeoutSec 2; if ($response.ok -eq $true -and $response.data.version) { $ready=$true; break } } catch {}
    }
    Start-Sleep -Milliseconds 500
  }
  if ($ready) { Start-Process 'http://127.0.0.1:4173/' | Out-Null }
  else { throw 'Startup did not become ready yet. Read logs\supervisor-status.json, then open http://127.0.0.1:4173/ after the service is ready.' }
}
