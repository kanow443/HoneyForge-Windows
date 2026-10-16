#Requires -Version 5.1
# A consistent centre snapshot; API writers are paused, sensor outboxes keep buffering.
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    Assert-HFDocker
    $config = Get-HFConfig
    $destination = [IO.Path]::GetFullPath($OutputDirectory)
    if (Test-Path $destination) { throw 'Use a new backup directory; existing evidence will not be overwritten.' }
    Protect-HFDirectory -Path $destination
    $cid = & docker.exe compose --env-file $script:HFEnv -p honeyforge-windows -f (Join-Path $script:HFRoot 'compose.production.yml') -f (Join-Path $script:HFRoot 'compose.windows.yml') ps -q api
    if ($LASTEXITCODE -ne 0 -or -not $cid) { throw 'API container not found. Start the centre before creating a backup.' }
    $mounts = (& docker.exe inspect --format '{{json .Mounts}}' $cid) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect centre storage.' }
    $evidence = @($mounts | Where-Object { $_.Destination -eq '/var/lib/honeyforge' })
    if ($evidence.Count -ne 1 -or $evidence[0].Type -ne 'volume') { throw 'Expected one persistent evidence volume.' }
    Invoke-HFCompose -Arguments @('stop', 'gateway', 'management', 'api')
    try {
        Invoke-HFCompose -Arguments @('exec', '-T', 'postgres', 'pg_dump', '-U', 'honeyforge', '-d', 'honeyforge', '--no-owner', '--no-acl', '-f', '/tmp/honeyforge-backup.sql')
        Invoke-HFCompose -Arguments @('cp', 'postgres:/tmp/honeyforge-backup.sql', (Join-Path $destination 'database.sql'))
        & docker.exe run --rm --network none --mount "type=volume,source=$($evidence[0].Name),target=/evidence,readonly" --mount "type=bind,source=$destination,target=/backup" postgres:17.7-alpine tar -C /evidence -czf /backup/evidence-and-keys.tar.gz .
        if ($LASTEXITCODE -ne 0) { throw 'Binary evidence/private key backup failed; backup is incomplete.' }
        foreach ($entry in @(
            @{ service = 'gateway'; archive = 'console-tls.tar.gz' },
            @{ service = 'management'; archive = 'management-tls.tar.gz' }
        )) {
            $tlsCid = & docker.exe compose --env-file $script:HFEnv -p honeyforge-windows -f (Join-Path $script:HFRoot 'compose.production.yml') -f (Join-Path $script:HFRoot 'compose.windows.yml') ps -aq $entry.service
            if ($LASTEXITCODE -ne 0 -or -not $tlsCid) { throw 'TLS gateway container is missing.' }
            $tlsMounts = (& docker.exe inspect --format '{{json .Mounts}}' $tlsCid) | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect TLS gateway storage.' }
            $tlsVolume = @($tlsMounts | Where-Object { $_.Destination -eq '/data' })
            if ($tlsVolume.Count -ne 1 -or $tlsVolume[0].Type -ne 'volume') { throw 'Unexpected TLS volume.' }
            & docker.exe run --rm --network none --mount "type=volume,source=$($tlsVolume[0].Name),target=/tls,readonly" --mount "type=bind,source=$destination,target=/backup" postgres:17.7-alpine tar -C /tls -czf "/backup/$($entry.archive)" .
            if ($LASTEXITCODE -ne 0) { throw 'TLS CA backup failed; backup is incomplete.' }
        }
        foreach ($file in @('production.env', 'config.json', 'console-ca.crt', 'management-ca.crt')) {
            Copy-Item (Join-Path $script:HFRuntime $file) (Join-Path $destination $file)
        }
        $geoDirectory = Join-Path $script:HFRuntime 'geo'
        if (Test-Path $geoDirectory) {
            & docker.exe run --rm --network none --mount "type=bind,source=$geoDirectory,target=/geo,readonly" --mount "type=bind,source=$destination,target=/backup" postgres:17.7-alpine tar -C /geo -czf /backup/geo-data.tar.gz .
            if ($LASTEXITCODE -ne 0) { throw 'Geo database backup failed.' }
        }
        $hashes = @{}
        Get-ChildItem -File $destination | ForEach-Object { $hashes[$_.Name] = @{ sha256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant(); bytes = $_.Length } }
        $manifest = @{ format = 'honeyforge-windows-backup-v2'; timestamp = [DateTime]::UtcNow.ToString('o'); files = $hashes; includesServerCaPrivateState = $true }
        Write-HFNewFile -Path (Join-Path $destination 'manifest.json') -Text ($manifest | ConvertTo-Json -Depth 5)
        Write-Host 'Consistent centre snapshot saved. It contains private keys and passwords; keep it off the presentation screen.'
    } finally {
        Invoke-HFCompose -Arguments @('up', '-d', '--wait', '--wait-timeout', '300')
        Invoke-HFCompose -Arguments @('exec', '-T', 'postgres', 'rm', '-f', '/tmp/honeyforge-backup.sql')
    }
} catch { Write-Error $_; exit 1 }
