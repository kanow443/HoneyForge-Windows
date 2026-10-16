#Requires -Version 5.1
# Fresh installation only. Restore offline writers, then start the centre.
param([Parameter(Mandatory = $true)][string]$BackupDirectory)
. (Join-Path $PSScriptRoot 'Common.ps1')
$restoreStarted = $false
try {
    Assert-HFDocker
    if (Test-Path $script:HFEnv) { throw 'Restore into a fresh extracted directory, before Setup. Existing credentials will not be overwritten.' }
    $source = (Resolve-Path $BackupDirectory).Path
    $manifest = Get-Content -Raw (Join-Path $source 'manifest.json') | ConvertFrom-Json
    if ($manifest.format -notin @('honeyforge-windows-backup-v1', 'honeyforge-windows-backup-v2')) { throw 'Unsupported backup format.' }
    $required = @('database.sql', 'evidence-and-keys.tar.gz', 'console-tls.tar.gz', 'management-tls.tar.gz', 'production.env', 'config.json', 'console-ca.crt', 'management-ca.crt')
    if ($manifest.format -eq 'honeyforge-windows-backup-v2' -and $manifest.files.PSObject.Properties['geo-data.tar.gz']) { $required += 'geo-data.tar.gz' }
    foreach ($name in $required) {
        $property = $manifest.files.PSObject.Properties[$name]
        if (-not $property) { throw "Missing manifest entry: $name" }
        $path = Join-Path $source $name
        if (-not (Test-Path $path)) { throw "Missing backup file: $name" }
        $item = Get-Item $path
        if ($item.Length -ne $property.Value.bytes -or (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant() -ne $property.Value.sha256) { throw "Backup integrity check failed: $name" }
    }
    $config = Get-Content -Raw (Join-Path $source 'config.json') | ConvertFrom-Json
    if (-not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $config.managementAddress -ErrorAction SilentlyContinue)) { throw 'Restore requires the backed-up static management IP on this Windows PC. Reserve that address first; see README_WINDOWS.md.' }
    $volumes = @(& docker.exe volume ls -q --filter 'label=com.docker.compose.project=honeyforge-windows')
    if ($LASTEXITCODE -ne 0 -or $volumes.Count -gt 0) { throw 'Restore requires an empty Docker project. Existing volumes will not be deleted. Use a clean machine/Docker installation.' }
    $restoreStarted = $true
    Protect-HFDirectory -Path $script:HFRuntime
    foreach ($name in @('production.env', 'config.json', 'console-ca.crt', 'management-ca.crt')) { Copy-Item (Join-Path $source $name) (Join-Path $script:HFRuntime $name) }
    $geoDirectory = Join-Path $script:HFRuntime 'geo'
    New-Item -ItemType Directory -Force -Path $geoDirectory | Out-Null
    if ($required -contains 'geo-data.tar.gz') {
        & docker.exe run --rm --network none --mount "type=bind,source=$geoDirectory,target=/geo" --mount "type=bind,source=$source,target=/backup,readonly" postgres:17.7-alpine tar -C /geo -xzf /backup/geo-data.tar.gz
        if ($LASTEXITCODE -ne 0) { throw 'Geo restore failed. API remains offline.' }
    } else { Install-HFBundledGeo }
    Invoke-HFCompose -Arguments @('create', '--build')
    foreach ($entry in @(
        @{ service = 'api'; target = '/var/lib/honeyforge'; archive = 'evidence-and-keys.tar.gz' },
        @{ service = 'gateway'; target = '/data'; archive = 'console-tls.tar.gz' },
        @{ service = 'management'; target = '/data'; archive = 'management-tls.tar.gz' }
    )) {
        $cid = & docker.exe compose --env-file $script:HFEnv -p honeyforge-windows -f (Join-Path $script:HFRoot 'compose.production.yml') -f (Join-Path $script:HFRoot 'compose.windows.yml') ps -aq $entry.service
        if ($LASTEXITCODE -ne 0 -or -not $cid) { throw 'Cannot find created container.' }
        $mounts = (& docker.exe inspect --format '{{json .Mounts}}' $cid) | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect destination storage.' }
        $mount = @($mounts | Where-Object { $_.Destination -eq $entry.target })
        if ($mount.Count -ne 1 -or $mount[0].Type -ne 'volume') { throw 'Unexpected destination volume.' }
        & docker.exe run --rm --network none --mount "type=volume,source=$($mount[0].Name),target=/target" --mount "type=bind,source=$source,target=/backup,readonly" postgres:17.7-alpine tar -C /target -xzf "/backup/$($entry.archive)"
        if ($LASTEXITCODE -ne 0) { throw 'Volume restore failed. API remains offline.' }
    }
    Invoke-HFCompose -Arguments @('up', '-d', '--wait', '--wait-timeout', '300', 'postgres')
    Invoke-HFCompose -Arguments @('cp', (Join-Path $source 'database.sql'), 'postgres:/tmp/honeyforge-restore.sql')
    Invoke-HFCompose -Arguments @('exec', '-T', 'postgres', 'psql', '-U', 'honeyforge', '-d', 'honeyforge', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '/tmp/honeyforge-restore.sql')
    Invoke-HFCompose -Arguments @('exec', '-T', 'postgres', 'rm', '-f', '/tmp/honeyforge-restore.sql')
    Invoke-HFCompose -Arguments @('up', '-d', '--wait', '--wait-timeout', '300')
    Export-HFCAs
    Test-HFConsole -Origin $config.origin
    Write-Host 'Restore completed. Login uses the original private production.env password. Keep the old centre offline.'
} catch {
    if ($restoreStarted) {
        try { Invoke-HFCompose -Arguments @('stop', 'gateway', 'management', 'api') } catch { Write-Warning 'Could not confirm stopped writers. Check Docker before retrying restore.' }
    }
    Write-Error $_; exit 1
}
