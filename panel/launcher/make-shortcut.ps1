# Creates the "Don Robert Wi-Fi" icon on this PC's desktop.
# Run once (right-click > Run with PowerShell), from the panel\launcher folder.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Don Robert Wi-Fi.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $here 'open-panel.vbs') + '"'
$lnk.WorkingDirectory = Split-Path -Parent $here
$lnk.IconLocation = (Join-Path $here 'don-robert-wifi.ico') + ',0'
$lnk.Description = 'Don Robert Cafe Wi-Fi slips and devices'
$lnk.Save()
Write-Output "Created: $lnkPath"
