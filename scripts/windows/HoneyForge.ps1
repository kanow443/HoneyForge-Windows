#Requires -Version 5.1
param(
    [ValidateSet('Setup', 'Start', 'Stop', 'Doctor', 'Demo', 'Geo')][string]$Action = 'Setup',
    [string]$ManagementAddress = '',
    [string]$SensorAddress = ''
)
. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    Assert-HFDocker
    if ($Action -eq 'Setup') {
        Protect-HFDirectory -Path $script:HFRuntime
        if (-not (Test-Path $script:HFEnv)) {
            if (Test-Path $script:HFConfigFile) { throw 'Configuration exists but its private env is missing. Restore the env from your backup; credentials cannot be reconstructed.' }
            if (-not $ManagementAddress) {
                $interfaces = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address })
                if ($interfaces.Count -ne 1) { throw 'Specify the IPv4 interface reachable from the Ubuntu VM: START_WINDOWS.cmd -Action Setup -ManagementAddress YOUR_WINDOWS_IP' }
                $ManagementAddress = $interfaces[0].IPv4Address[0].IPAddress
            }
            $ip = [Net.IPAddress]::Parse($ManagementAddress)
            if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or [Net.IPAddress]::IsLoopback($ip) -or $ip.Equals([Net.IPAddress]::Any)) { throw 'ManagementAddress must be a non-loopback IPv4 address on this Windows PC.' }
            if (-not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ManagementAddress -ErrorAction SilentlyContinue)) { throw 'ManagementAddress is not assigned to this Windows PC.' }
            foreach ($port in @(8080, 8443, 18443)) {
                if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Port $port is already in use. Stop its owner or use another machine before first setup." }
            }
            $password = Get-HFSecret
            $envText = @"
HF_SITE_DOMAIN=localhost
HF_PUBLIC_ORIGIN=https://localhost:8443
HF_HTTP_PORT=8080
HF_HTTPS_PORT=8443
HF_HTTP_BIND=127.0.0.1
HF_MANAGEMENT_DOMAIN=asset-sync.test
HF_MANAGEMENT_PORT=18443
HF_MANAGEMENT_BIND=$ManagementAddress
HF_MANAGEMENT_TLS=internal
HF_SYNC_PROXY_SECRET=$(Get-HFSecret)
POSTGRES_PASSWORD=$(Get-HFSecret)
HF_ADMIN_USERNAME=operator
HF_ADMIN_PASSWORD=$password
"@
            Write-HFNewFile -Path $script:HFEnv -Text ($envText + "`n")
            $config = @{ origin = 'https://localhost:8443'; managementAddress = $ManagementAddress; managementOrigin = "https://asset-sync.test:18443"; project = 'honeyforge-windows' }
            Write-HFNewFile -Path $script:HFConfigFile -Text ($config | ConvertTo-Json)
            Write-HFNewFile -Path (Join-Path $script:HFRuntime 'access.txt') -Text "URL: https://localhost:8443`nUsername: operator`nPassword: $password`n"
        }
        Install-HFBundledGeo
        $geoDirectory = Join-Path $script:HFRuntime 'geo'
        New-Item -ItemType Directory -Force -Path $geoDirectory | Out-Null
        if (-not (Test-Path (Join-Path $geoDirectory 'dbip-city-lite.mmdb')) -or -not (Test-Path (Join-Path $geoDirectory 'dbip-asn-lite.mmdb'))) { Update-HFGeo }
        $config = Get-HFConfig
        if ($ManagementAddress -and $ManagementAddress -ne $config.managementAddress) { throw 'This installation already has another management address. Review README_WINDOWS.md before migrating; secrets and identities were preserved.' }
        Invoke-HFCompose -Arguments @('up', '-d', '--build', '--wait', '--wait-timeout', '300')
        Export-HFCAs
        Test-HFConsole -Origin $config.origin
        Write-Host "Operator credentials: $script:HFRuntime\access.txt (private; do not show on screen)."
        Write-Host "Sensor centre URL: $($config.managementOrigin)"
        Write-Host 'Next: configure the Ubuntu VM and use scripts/windows/install-sensor-ubuntu.sh. See README_WINDOWS.md.'
        Start-Process $config.origin
    } elseif ($Action -eq 'Start') {
        Install-HFBundledGeo
        $config = Get-HFConfig
        if (-not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $config.managementAddress -ErrorAction SilentlyContinue)) { throw 'Windows IP changed. Restore the reserved address or follow the address migration procedure in README_WINDOWS.md.' }
        Invoke-HFCompose -Arguments @('up', '-d', '--wait', '--wait-timeout', '300')
        Export-HFCAs
        Test-HFConsole -Origin $config.origin
        Start-Process $config.origin
    } elseif ($Action -eq 'Stop') {
        $null = Get-HFConfig
        Invoke-HFCompose -Arguments @('stop')
        Write-Host 'Centre stopped. Data, certificates and sensor identities retained.'
    } elseif ($Action -eq 'Doctor') {
        $config = Get-HFConfig
        Invoke-HFCompose -Arguments @('ps')
        Test-HFConsole -Origin $config.origin
        Write-Host "Management endpoint: $($config.managementOrigin)"
        Write-Host "Windows interface present: $([bool](Get-NetIPAddress -AddressFamily IPv4 -IPAddress $config.managementAddress -ErrorAction SilentlyContinue))"
        if ($SensorAddress) {
            foreach ($port in @(22, 2222, 2223, 18080)) {
                $check = Test-NetConnection -ComputerName $SensorAddress -Port $port -WarningAction SilentlyContinue
                Write-Host "Sensor port $port reachable: $($check.TcpTestSucceeded)"
            }
        }
        Write-Host 'These checks do not prove agent enrollment or runtime collection. Confirm Online in Hosts and Running in Traps, then perform a real attack.'
    } elseif ($Action -eq 'Geo') {
        $null = Get-HFConfig
        Update-HFGeo
        Invoke-HFCompose -Arguments @('up', '-d', '--no-deps', 'api')
        Write-Host 'Geo databases updated. Confirm Available and their build dates on the Geo/ASN screen.'
    } elseif ($Action -eq 'Demo') {
        $config = Get-HFConfig
        if (-not $SensorAddress) { throw 'Provide the enrolled sensor IP: START_WINDOWS.cmd -Action Demo -SensorAddress YOUR_UBUNTU_IP' }
        $ip = [Net.IPAddress]::Parse($SensorAddress)
        if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Use the enrolled IPv4 address.' }
        Push-Location $script:HFRoot
        try {
            Get-Content -Raw (Join-Path $PSScriptRoot 'prepare-demo.py') |
                & docker.exe compose --env-file $script:HFEnv -p honeyforge-windows -f compose.production.yml -f compose.windows.yml exec -T api /app/.venv/bin/python - $SensorAddress
            if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed during Demo; private configuration was preserved.' }
        } finally { Pop-Location }
    }
} catch { Write-Error $_; exit 1 }
