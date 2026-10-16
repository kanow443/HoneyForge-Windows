#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { throw 'Right-click INSTALL_PREREQUISITES.cmd > Run as administrator.' }
    $reboot = $false
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $state = Get-WindowsOptionalFeature -Online -FeatureName $feature
        if ($state.State -ne 'Enabled') {
            $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
            $reboot = $reboot -or $result.RestartNeeded
        }
    }
    if ($reboot) {
        Write-Host 'Restart Windows, then run INSTALL_PREREQUISITES.cmd again. No automatic restart was requested.'
        exit 3010
    }
    & wsl.exe --update
    if ($LASTEXITCODE -ne 0) { throw 'WSL update failed. Check Microsoft Store/network access and virtualisation in BIOS.' }
    & wsl.exe --set-default-version 2
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enable WSL2. Check BIOS virtualisation and restart Windows.' }
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Install App Installer from Microsoft Store or Docker Desktop manually: https://docs.docker.com/desktop/setup/install/windows-install/' }
        & winget.exe install --id Docker.DockerDesktop --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop installation failed. See the installer message above.' }
    }
    foreach ($desktop in @((Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'))) {
        if (Test-Path $desktop) { Start-Process $desktop; break }
    }
    Write-Host 'Open Docker Desktop, finish its first-run screens, select Linux containers / WSL2, and wait for Engine running.'
    Write-Host 'Then extract the ZIP to C:\HoneyForge and run START_WINDOWS.cmd as your normal user.'
} catch { Write-Error $_; exit 1 }
