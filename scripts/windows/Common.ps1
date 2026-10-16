Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:HFRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:HFRuntime = Join-Path $script:HFRoot '.runtime\windows'
$script:HFConfigFile = Join-Path $script:HFRuntime 'config.json'
$script:HFEnv = Join-Path $script:HFRuntime 'production.env'
function Protect-HFDirectory {
    param([string]$Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot protect private state with Windows ACLs. Extract onto an NTFS disk.' }
}
function Write-HFNewFile {
    param([string]$Path, [string]$Text)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
function Get-HFSecret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Assert-HFDocker {
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
        foreach ($bin in @((Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'), (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'))) {
            if (Test-Path (Join-Path $bin 'docker.exe')) { $env:Path = "$bin;$env:Path"; break }
        }
    }
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is missing. Run INSTALL_PREREQUISITES.cmd as administrator first.' }
    $os = & docker.exe info --format '{{.OSType}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or "$os".Trim() -ne 'linux') { throw 'Start Docker Desktop and wait for Engine running. Select Linux containers, not Windows containers.' }
    & docker.exe compose version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required; update Docker Desktop.' }
}
function Invoke-HFCompose {
    param([string[]]$Arguments)
    Push-Location $script:HFRoot
    try {
        & docker.exe compose --env-file $script:HFEnv -p honeyforge-windows -f compose.production.yml -f compose.windows.yml @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed during $($Arguments[0]); private configuration was preserved." }
    } finally { Pop-Location }
}
function Get-HFConfig {
    if (-not (Test-Path $script:HFConfigFile) -or -not (Test-Path $script:HFEnv)) { throw 'Run START_WINDOWS.cmd first to initialise this installation.' }
    return Get-Content -Raw $script:HFConfigFile | ConvertFrom-Json
}
function Export-HFCAs {
    Invoke-HFCompose -Arguments @('cp', 'gateway:/data/caddy/pki/authorities/local/root.crt', (Join-Path $script:HFRuntime 'console-ca.crt'))
    Invoke-HFCompose -Arguments @('cp', 'management:/data/caddy/pki/authorities/local/root.crt', (Join-Path $script:HFRuntime 'management-ca.crt'))
    $ca = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $script:HFRuntime 'console-ca.crt'))
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        if ($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $ca.Thumbprint, $false).Count -eq 0) {
            $store.Add($ca)
        }
    } finally { $store.Close() }
    Write-Host 'Local console CA installed in the current user trust store. Public management CA exported for the sensor.'
}
function Test-HFConsole {
    param([string]$Origin)
    $result = & curl.exe --fail --silent --show-error --ssl-revoke-best-effort --noproxy '*' --cacert (Join-Path $script:HFRuntime 'console-ca.crt') "$Origin/health/ready"
    if ($LASTEXITCODE -ne 0) { throw 'Verified HTTPS readiness failed. Check Doctor; TLS verification remains enabled.' }
    $health = "$result" | ConvertFrom-Json
    if (-not $health) { throw 'The centre returned an empty readiness response.' }
    Write-Host 'Centre ready over verified HTTPS.'
}

function Update-HFGeo {
    $directory = Join-Path $script:HFRuntime 'geo'
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    Invoke-HFCompose -Arguments @('build', 'api')
    $image = & docker.exe image inspect honeyforge-windows-api --format '{{.Id}}'
    if ($LASTEXITCODE -ne 0) { throw 'Built API image is unavailable.' }
    if (-not $image) { throw 'Cannot find the built API image for Geo updater.' }
    Write-Host 'Installing verified DB-IP City and ASN Lite databases (CC BY 4.0); the first download takes several minutes.'
    & docker.exe run --rm --mount "type=bind,source=$directory,target=/geo-update" --entrypoint /app/.venv/bin/python "$image" -m honeyforge.infrastructure.geo_update --directory /geo-update
    if ($LASTEXITCODE -ne 0) { throw 'Geo download failed. Existing databases were preserved. Re-run START_WINDOWS.cmd -Action Geo after checking network access.' }
}

function Install-HFBundledGeo {
    $directory = Join-Path $script:HFRuntime 'geo'
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $bundle = Join-Path $script:HFRoot 'data\geo'
    foreach ($kind in @('city', 'asn')) {
        $name = "dbip-$kind-lite.mmdb"
        $target = Join-Path $directory $name
        if (-not (Test-Path $target) -and (Test-Path (Join-Path $bundle $name))) {
            $metadata = Get-Content -Raw (Join-Path $bundle "dbip-$kind-lite.json") | ConvertFrom-Json
            $source = Join-Path $bundle $name
            if ((Get-FileHash -Algorithm SHA256 $source).Hash.ToLowerInvariant() -ne $metadata.sha256) { throw 'Bundled Geo database integrity check failed.' }
            Copy-Item $source $target
            Copy-Item (Join-Path $bundle "dbip-$kind-lite.json") (Join-Path $directory "dbip-$kind-lite.json")
        }
    }
}
