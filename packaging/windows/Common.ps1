Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
# Use Windows PowerShell's own modules even when launched by PowerShell 7 or an AI host.
$env:PSModulePath = Join-Path $PSHOME 'Modules'

function Get-InstallRoot([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { $Value = Join-Path $env:LOCALAPPDATA 'ScoutAmazon' }
  $resolved = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($resolved -notmatch '^[A-Za-z]:\\.+') { throw 'InstallRoot must be an absolute local directory, not a drive root or UNC path.' }
  $cursor = $resolved
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Installation paths must not contain reparse points.' }
    $cursor = Split-Path -Parent $cursor
  }
  return $resolved
}
function Assert-WithinRoot([string]$Root, [string]$Candidate) {
  $resolved = [IO.Path]::GetFullPath($Candidate)
  if (-not $resolved.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe path outside installation root.' }
  $cursor = $resolved
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
    if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Installation paths must not contain reparse points.' }
    $cursor = Split-Path -Parent $cursor
  }
  return $resolved
}
function Read-Installation([string]$Root) {
  foreach ($relative in @('control\installation.json','control\scripts','app','data','config','logs','exports')) { $null = Assert-WithinRoot $Root (Join-Path $Root $relative) }
  $file = Join-Path $Root 'control\installation.json'
  if (-not (Test-Path -LiteralPath $file)) { throw 'Installation identity is missing. No process was changed.' }
  $record = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($record.product -ne 'scout-amazon-agent-windows' -or $record.installRoot -ne $Root) { throw 'Installation identity does not match this path.' }
  return $record
}
function Write-JsonAtomic([string]$Path, $Value) {
  $temporary = $Path + '.' + $PID + '.tmp'
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Get-InstanceKey([string]$Root) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())))).Replace('-', '').Substring(0,20) }
  finally { $sha.Dispose() }
}
function Get-OwnedServiceProcesses([string]$Root, [string]$Script) {
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'control\installation.json'))) { return @() }
  $nodePath = [string](Read-Installation $Root).nodePath
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -eq $nodePath) -and $_.CommandLine -and
      $_.CommandLine.Contains('"' + $Script + '"')
  })
}
function Get-OwnedSupervisorProcesses([string]$Root) {
  $scriptPath = Join-Path $Root 'control\scripts\Supervisor.ps1'
  @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -eq (Get-SystemPowerShell)) -and
      $_.CommandLine -and $_.CommandLine.Contains('"' + $scriptPath + '"') -and $_.CommandLine.Contains('"' + $Root + '"')
  })
}
function Get-PortListeners([int]$Port) {
  $rows = @(& "$env:SystemRoot\System32\netstat.exe" -ano -p TCP)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect local ports safely.' }
  $ids = @()
  foreach ($line in $rows) {
    if ($line -match ('^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$')) { $ids += [int]$Matches[1] }
  }
  return @($ids | Select-Object -Unique)
}
function Get-SystemPowerShell { return Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
function Get-ServiceDefinitions([string]$Root) {
  @(
    @{ name='bridge'; port=16880; path=(Assert-WithinRoot $Root (Join-Path $Root 'app\1688-dependencies\1688-procurement-assistant-2.3.0\server.mjs')); endpoint='http://127.0.0.1:16880/api/v1/runtime' },
    @{ name='scout'; port=4173; path=(Assert-WithinRoot $Root (Join-Path $Root 'app\server.mjs')); endpoint='http://127.0.0.1:4173/api/version' }
  )
}
function Set-InstallationEnvironment([string]$Root) {
  $env:SCOUT_PORT = '4173'
  $env:SCOUT_MONITOR_ENABLED = '1'
  $env:SCOUT_DATA_DIR = Join-Path $Root 'data\scout'
  $env:SCOUT_SELLERSPRITE_CONFIG_PATH = Join-Path $Root 'config\sellersprite.local.toml'
  $env:SCOUT_1688_PROJECT_ROOT = Join-Path $Root 'app\1688-dependencies\1688-procurement-assistant-2.3.0'
  $env:BB1688_IMAGE_FINDER_ROOT = Join-Path $Root 'app\1688-dependencies\1688-image-finder'
  $env:BB1688_HOME = Join-Path $Root 'data\1688-session'
  $env:BB1688_DATA_ROOT = Join-Path $Root 'data\sourcing-console'
  $env:SCOUT_EXPORT_DIRECTORY = Join-Path $Root 'exports'
  $env:SCOUT_EXPORT_DIR = Join-Path $Root 'exports'
  foreach ($name in @('SCOUT_CODEX_CONFIG_PATH','NODE_OPTIONS','NODE_PATH','SCOUT_1688_PORT','BB1688_PORT','BB1688_SEARCH_MIN_GAP_MS','BB1688_SEARCH_COOLDOWN_MS')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
}
function Assert-ServicePortsAvailable([string]$Root) {
  foreach ($service in (Get-ServiceDefinitions $Root)) {
    $listeners = @(Get-PortListeners $service.port)
    $owned = @(Get-OwnedServiceProcesses $Root $service.path)
    foreach ($listenerId in $listeners) {
      if ($listenerId -notin @($owned | ForEach-Object { [int]$_.ProcessId })) { throw "Port $($service.port) belongs to another application or installation. Nothing was stopped." }
    }
  }
}

function Resolve-NodeRuntime([string]$NodePath) {
  if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw 'Node.js 24.x Windows x64 is required. Install Node.js, reopen this installer, or supply -NodePath.' }
    $NodePath = $command.Source
  }
  $resolved = [IO.Path]::GetFullPath($NodePath)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'Configured Node.js executable does not exist.' }
  $savedOptions = $env:NODE_OPTIONS
  $savedNodePath = $env:NODE_PATH
  try {
    $env:NODE_OPTIONS = $null; $env:NODE_PATH = $null
    $infoText = & $resolved -e 'process.stdout.write(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath}))'
    if ($LASTEXITCODE -ne 0) { throw 'Node.js runtime validation failed.' }
    $info = $infoText | ConvertFrom-Json
  } finally { $env:NODE_OPTIONS = $savedOptions; $env:NODE_PATH = $savedNodePath }
  if ($info.version -notmatch '^v24[.]' -or $info.platform -ne 'win32' -or $info.arch -ne 'x64') { throw 'This package requires Node.js 24.x for Windows x64. No global runtime was changed.' }
  return [IO.Path]::GetFullPath([string]$info.execPath)
}
