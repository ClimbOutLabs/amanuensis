# Aman setup on Windows.
#
# Windows runs Aman inside WSL2 (the Windows Subsystem for Linux), the
# same Ubuntu the setup wizard supports on Linux. This script does the
# Windows half: it checks that this computer can run WSL2, installs it
# when it is missing, and then tells you the few steps that finish the
# job, because those steps need a restart and two programs only you can
# open. Every problem it finds is printed with the one thing to do next.
#
# Run it from a PowerShell window opened as administrator
# (Start menu, type PowerShell, right-click, Run as administrator).

$ErrorActionPreference = 'Stop'

function Say-Problem($happened, $fix) {
  Write-Host ''
  Write-Host "Problem: $happened"
  Write-Host "Do this: $fix"
}

# 1. This window must be an administrator window: installing WSL2
# changes Windows itself.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say-Problem 'This window is not an administrator window, so Windows features cannot be installed from it.' 'Close this window, open the Start menu, type PowerShell, right-click Windows PowerShell, choose Run as administrator, and run this script again.'
  exit 1
}

# 2. Virtualization must be on: WSL2 runs Ubuntu in a light virtual
# machine, and the computer's own setting for that is sometimes off.
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
if ($cpu -and $cpu.VirtualizationFirmwareEnabled -eq $false) {
  Say-Problem 'Virtualization is turned off in this computer''s BIOS or UEFI settings, and WSL2 needs it on.' 'Restart the computer and open its BIOS or UEFI settings (often by pressing Delete or F2 while it starts). Turn on the setting named Virtualization, Intel VT-x or SVM Mode, save and restart, then run this script again.'
  exit 1
}

# 3. WSL2 with Ubuntu. When it is already here, this step changes
# nothing and the script moves on.
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
$ubuntu = $null
if ($wsl) {
  $listed = & wsl.exe --list --quiet 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() }
  $ubuntu = $listed | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
}
if (-not $ubuntu) {
  Write-Host 'Installing WSL2 and Ubuntu. This can take a few minutes.'
  & wsl.exe --install -d Ubuntu
  if ($LASTEXITCODE -ne 0) {
    Say-Problem 'Windows could not install WSL2 and Ubuntu.' 'Check that this computer runs Windows 10 version 2004 or newer, or Windows 11 (Start menu, Settings, System, About). Update Windows if it is older, restart, and run this script again.'
    exit 1
  }
  Write-Host ''
  Write-Host 'WSL2 and Ubuntu are installed. Restart the computer now: Ubuntu cannot start until Windows has restarted.'
  Write-Host 'After the restart, do these three things:'
  Write-Host '  1. Open Ubuntu from the Start menu and finish its first-run questions (it asks you to pick a user name and a password).'
  Write-Host '  2. Install Docker Desktop from docker.com, open it, choose Settings, then Resources, then WSL Integration, turn on Ubuntu, and choose Apply & Restart.'
  Write-Host '  3. In Ubuntu, run the Aman setup commands printed in the Windows install guide: they fetch Aman and open the setup wizard in your browser.'
  exit 0
}

# 4. WSL2 and Ubuntu are already here: say the remaining steps.
Write-Host 'WSL2 and Ubuntu are already on this computer.'
Write-Host 'To set Aman up:'
Write-Host '  1. Open Ubuntu from the Start menu.'
Write-Host '  2. Open Docker Desktop, choose Settings, then Resources, then WSL Integration, and make sure Ubuntu is on. Choose Apply & Restart if you changed it.'
Write-Host '  3. In Ubuntu, run the Aman setup commands printed in the Windows install guide: they fetch Aman and open the setup wizard in your browser.'
