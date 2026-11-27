# Test only, run after the setup window tests on a Windows machine
# where PowerShell's transcripts and script logging were turned on
# first. It fails when a password the tests typed shows up in what
# PowerShell recorded about the setup window, and when PowerShell
# recorded nothing at all, since then the check would prove nothing.
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'

# Put together here, so this script's own record does not hold it.
$typed = 'Canary' + '7!'
# A word only the setup window script holds, put together the same way.
$marker = 'Secure' + 'Password'

$all = @(Get-ChildItem -Recurse -File $Dir)
$ofWindow = @($all | Where-Object { (Get-Content $_.FullName -Raw) -match '-InputFormat None' })
Write-Output "Transcripts: $($all.Count), of the setup window: $($ofWindow.Count)"
if ($ofWindow.Count -eq 0) {
  throw 'PowerShell wrote no transcript of the setup window, so this check proves nothing.'
}
foreach ($file in $ofWindow) {
  if ((Get-Content $file.FullName -Raw).Contains($typed)) {
    throw "A password typed in the setup window is in the transcript $($file.Name)."
  }
}

$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PowerShell/Operational'; Id = 4104 } -ErrorAction SilentlyContinue)
$ofScript = @($events | Where-Object { $_.Message.Contains($marker) })
Write-Output "Script log entries: $($events.Count), of the setup window: $($ofScript.Count)"
if ($ofScript.Count -eq 0) {
  throw 'PowerShell logged none of the setup window script, so this check proves nothing.'
}
foreach ($entry in $events) {
  if ($entry.Message.Contains($typed)) {
    throw 'A password typed in the setup window is in the PowerShell script log.'
  }
}
Write-Output 'Nothing typed in the setup window was recorded.'
