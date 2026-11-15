# Test only: stands in for a person at the setup window, through the
# same Windows accessibility interface a screen reader uses. The steps
# arrive on standard input, never as arguments, so what the person
# types is not on this script's own command line. They are one line
# each, as base64 of UTF-8: click:<id>, set:<id>:<text>, select:<id>,
# read:<id>, close, or commandlines:<parent pid>. What a read finds is
# printed, one line for each.
$ErrorActionPreference = 'Stop'
$Steps = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())).Split("`n")
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$auto = [Windows.Automation.AutomationElement]
$window = $null
function Find-Window {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $condition = [Windows.Automation.PropertyCondition]::new($auto::NameProperty, 'Aman Setup')
    $found = $auto::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
    if ($null -ne $found) { return $found }
    Start-Sleep -Milliseconds 250
  }
  throw 'the setup window did not appear'
}
function Find-Part([string]$id) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $condition = [Windows.Automation.PropertyCondition]::new($auto::AutomationIdProperty, $id)
    $found = $script:window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $found -and $found.Current.IsEnabled -and -not $found.Current.IsOffscreen) { return $found }
    Start-Sleep -Milliseconds 200
  }
  throw "the part $id did not appear or stayed switched off"
}

foreach ($step in $Steps) {
  $parts = $step.Split(':', 3)
  if ($parts[0] -eq 'commandlines') {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parts[1])" | ForEach-Object { Write-Output "commandline=$($_.CommandLine)" }
    continue
  }
  if ($null -eq $window) { $window = Find-Window }
  switch ($parts[0]) {
    'click' { (Find-Part $parts[1]).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
    'set' { (Find-Part $parts[1]).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($parts[2]) }
    'select' { (Find-Part $parts[1]).GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select() }
    'read' { Write-Output "$($parts[1])=$((Find-Part $parts[1]).Current.Name)" }
    'close' { $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close() }
    default { throw "unknown step $step" }
  }
}
