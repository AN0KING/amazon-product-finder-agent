param([string]$InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
$installDirectory = Get-InstallRoot $InstallRoot
$null = Read-Installation $installDirectory
& (Join-Path $PSScriptRoot 'Stop.ps1') -InstallRoot $installDirectory
$shortcutFile = Join-Path $installDirectory 'control\shortcuts.json'
if (Test-Path -LiteralPath $shortcutFile) {
  $shortcuts = Get-Content -LiteralPath $shortcutFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $shell = New-Object -ComObject WScript.Shell
  foreach ($kind in @('startup','desktop')) {
    $shortcutPath = [string]$shortcuts.$kind
    $folder = [Environment]::GetFolderPath($(if ($kind -eq 'startup') { 'Startup' } else { 'Desktop' }))
    $expected = $(if ($kind -eq 'startup') { 'ScoutAmazon-' } else { 'Scout Amazon ' }) + (Get-InstanceKey $installDirectory) + '.lnk'
    if ($shortcutPath -ne (Join-Path $folder $expected)) { throw 'Shortcut path identity mismatch. Shortcut preserved.' }
    if (Test-Path -LiteralPath $shortcutPath) {
      $shortcut = $shell.CreateShortcut($shortcutPath)
      if ($shortcut.TargetPath -ne (Get-SystemPowerShell) -or -not $shortcut.Arguments.Contains('"' + (Join-Path $installDirectory 'control\scripts\Start.ps1') + '"')) { throw 'Shortcut target changed. Shortcut preserved.' }
      Remove-Item -LiteralPath $shortcutPath
    }
  }
}
Write-Output "Automatic startup removed. All installation files and personal data are preserved at $installDirectory. You may archive or remove this directory manually."
