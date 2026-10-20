param(
  [string]$InstallRoot,
  [string]$NodePath,
  [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$NoStart,
  [switch]$NoShortcuts
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$installDirectory = Get-InstallRoot $InstallRoot
$nodeRuntimePath = Resolve-NodeRuntime $NodePath
$packageDirectory = [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
if ($installDirectory -eq $packageDirectory -or $installDirectory.StartsWith($packageDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Install outside the extracted package directory.' }
$manifestPath = Join-Path $packageDirectory 'package-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Package manifest missing. Extract the complete ZIP before installing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.product -ne 'scout-amazon-agent-windows' -or -not $manifest.files.Count) { throw 'Invalid package identity.' }
if ($manifest.requirements.node -ne '24.x' -or $manifest.requirements.arch -ne 'x64') { throw 'Package runtime requirements are not supported.' }
$stageName = 'app.stage.' + [guid]::NewGuid().ToString('N').Substring(0,8)
$stageDirectory = Join-Path $installDirectory $stageName
$payloadScript = Join-Path $PSScriptRoot 'install-payload.mjs'
function Invoke-InstallationPayload([string]$Mode) {
  $savedOptions = $env:NODE_OPTIONS
  $savedNodePath = $env:NODE_PATH
  try {
    $env:NODE_OPTIONS = $null; $env:NODE_PATH = $null
    & $nodeRuntimePath $payloadScript $Mode $packageDirectory $installDirectory $stageDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Package payload validation or copy failed. No task data was changed.' }
  } finally { $env:NODE_OPTIONS=$savedOptions; $env:NODE_PATH=$savedNodePath }
}
Invoke-InstallationPayload 'validate'
foreach ($required in @('application/server.mjs','application/package.json','windows/Start.ps1','windows/Supervisor.ps1','windows/Common.ps1','windows/Stop.ps1','windows/Uninstall.ps1','windows/install-payload.mjs')) {
  if ($required -notin @($manifest.files | ForEach-Object { $_.path })) { throw "Required package file missing: $required" }
}
if (Test-Path -LiteralPath $installDirectory) {
  $items = @(Get-ChildItem -LiteralPath $installDirectory -Force)
  if ($items.Count) { $null = Read-Installation $installDirectory }
}
foreach ($service in (Get-ServiceDefinitions $installDirectory)) {
  if (@(Get-OwnedServiceProcesses $installDirectory $service.path).Count) { throw 'This installation is running. Pause active work and use Stop.cmd before upgrading; data will be preserved.' }
}
if (@(Get-OwnedSupervisorProcesses $installDirectory).Count) { throw 'This installation supervisor is running. Use Stop.cmd before upgrading.' }
# Offline staging does not inspect or interfere with services already running on this computer.
if (-not $NoStart) { Assert-ServicePortsAvailable $installDirectory }
$null = New-Item -ItemType Directory -Force -Path $installDirectory
foreach ($dir in @('data\scout','data\sourcing-console','data\1688-session','exports','config','logs','control\scripts')) {
  $directory = Assert-WithinRoot $installDirectory (Join-Path $installDirectory $dir)
  $null = New-Item -ItemType Directory -Force -Path $directory
  $null = Assert-WithinRoot $installDirectory $directory
}
Invoke-InstallationPayload 'copy'
$appDirectory = Join-Path $installDirectory 'app'
if (Test-Path -LiteralPath $appDirectory) {
  $previous = Assert-WithinRoot $installDirectory (Join-Path $installDirectory ('app.previous.' + [guid]::NewGuid().ToString('N')))
  Move-Item -LiteralPath $appDirectory -Destination $previous
}
Move-Item -LiteralPath $stageDirectory -Destination $appDirectory
$example = Join-Path $appDirectory 'config\sellersprite.example.toml'
if (Test-Path -LiteralPath $example) { Copy-Item -LiteralPath $example -Destination (Join-Path $installDirectory 'config\sellersprite.example.toml') -Force }
$identity = @{ product='scout-amazon-agent-windows'; version=$manifest.version; installRoot=$installDirectory; nodePath=$nodeRuntimePath; installedAt=[DateTime]::UtcNow.ToString('o'); instanceKey=(Get-InstanceKey $installDirectory) }
Write-JsonAtomic (Join-Path $installDirectory 'control\installation.json') $identity
foreach ($action in @('Start','Stop','Uninstall')) {
  $batch = '@echo off' + "`r`n" + '"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0control\scripts\' + $action + '.ps1" -InstallRoot "%~dp0."' + "`r`n" + 'if errorlevel 1 pause' + "`r`n"
  [IO.File]::WriteAllText((Join-Path $installDirectory ($action + '.cmd')), $batch, [Text.Encoding]::ASCII)
}
if (-not $NoShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcutPaths = @{
    startup=(Join-Path ([Environment]::GetFolderPath('Startup')) ('ScoutAmazon-' + $identity.instanceKey + '.lnk'))
    desktop=(Join-Path ([Environment]::GetFolderPath('Desktop')) ('Scout Amazon ' + $identity.instanceKey + '.lnk'))
  }
  foreach ($kind in @('startup','desktop')) {
    $shortcut = $shell.CreateShortcut($shortcutPaths[$kind])
    $shortcut.TargetPath = Get-SystemPowerShell
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $installDirectory 'control\scripts\Start.ps1') + '" -InstallRoot "' + $installDirectory + '"' + $(if ($kind -eq 'startup') { ' -NoBrowser' } else { '' })
    $shortcut.WorkingDirectory = $installDirectory
    $shortcut.Description = 'Scout Amazon independent local service'
    $shortcut.WindowStyle = 7
    $shortcut.Save()
  }
  Write-JsonAtomic (Join-Path $installDirectory 'control\shortcuts.json') $shortcutPaths
}
Write-Output "Installed offline at $installDirectory. Personal data and SellerSprite configuration were preserved."
if (-not $NoStart) { & (Join-Path $installDirectory 'control\scripts\Start.ps1') -InstallRoot $installDirectory }
