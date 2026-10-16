#Requires -Version 5.1
#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$SensorAddress)
. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    $config = Get-HFConfig
    $ip = [Net.IPAddress]::Parse($SensorAddress)
    if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or [Net.IPAddress]::IsLoopback($ip) -or $ip.Equals([Net.IPAddress]::Any)) { throw 'Use the IPv4 address of your dedicated Ubuntu VM.' }
    $name = 'HoneyForge-Management-' + $SensorAddress.Replace('.', '-')
    $existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if ($existing) { Remove-NetFirewallRule -Name $name }
    New-NetFirewallRule -Name $name -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $config.managementAddress -LocalPort 18443 -RemoteAddress $SensorAddress -Profile Any | Out-Null
    Write-Host "Only $SensorAddress may reach management on $($config.managementAddress):18443 through this rule."
} catch { Write-Error $_; exit 1 }
