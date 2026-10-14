Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Docker {
    param([Parameter(Mandatory)][string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE). See the message above." }
}

function Assert-DockerDesktop {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Install and start Docker Desktop with its WSL 2 backend first: https://www.docker.com/products/docker-desktop/'
    }
    $engine = (Invoke-Docker -Arguments @('info', '--format', '{{.OSType}}/{{.Architecture}}') | Out-String).Trim()
    if ($engine -notin @('linux/x86_64', 'linux/amd64')) {
        throw "This package requires Docker Desktop Linux containers on Windows x64. Current engine: $engine"
    }
    $version = (Invoke-Docker -Arguments @('compose', 'version', '--short') | Out-String).Trim()
    if ($version -notmatch '(\d+\.\d+\.\d+)' -or [version]$Matches[1] -lt [version]'2.20.0') {
        throw 'Docker Compose 2.20 or newer is required. Update Docker Desktop.'
    }
}

function Assert-Package {
    param([Parameter(Mandatory)][string]$Root)
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = @('Common.ps1','Install.ps1','Manage.ps1','Install.cmd','Start.cmd','Stop.cmd','Backup.cmd','README.txt','compose.yaml','images.tar.gz')
    if ($manifest.platform -ne 'linux/amd64' -or $manifest.schema -ne 1) { throw 'Unsupported package format.' }
    $names = @($manifest.files.PSObject.Properties.Name)
    if (@(Compare-Object $expected $names).Count -ne 0) { throw 'Package file list is incomplete or invalid.' }
    foreach ($name in $expected) {
        $path = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing package file: $name. Extract the entire ZIP first." }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        if ($actual -ne $manifest.files.$name) { throw "Checksum mismatch: $name. Download and extract the package again." }
    }
}

function New-RandomHex {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Protect-Directory {
    param([Parameter(Mandatory)][string]$Path)
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
    foreach ($identity in @($user, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-MarkSixConfig {
    param([string]$Path, [string]$Username, [string]$Password, [int]$Port = 8088)
    if (Test-Path -LiteralPath $Path) { return } # Never rotate credentials on re-install.
    if ($Username -notmatch '^[A-Za-z0-9_.-]{1,80}$') { throw 'Account must contain 1-80 letters, digits, dots, underscores or hyphens.' }
    if ($Password.Length -lt 12 -or [Text.Encoding]::UTF8.GetByteCount($Password) -gt 256 -or $Password -match "['\\\r\n]") {
        throw 'Password must have at least 12 characters, at most 256 UTF-8 bytes, and no single quotes, backslashes or newlines.'
    }
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
    Protect-Directory -Path (Split-Path -Parent $Path)
    $content = "DB_PASSWORD=$(New-RandomHex)`nDB_ROOT_PASSWORD=$(New-RandomHex)`nADMIN_USERNAME=$Username`nADMIN_PASSWORD='$Password'`nPORT=$Port`n"
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($content)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Invoke-MarkSixCompose {
    param([string]$Root, [Parameter(Mandatory)][string[]]$Arguments)
    $config = Join-Path $Root 'data\.env'
    if (-not (Test-Path -LiteralPath $config)) { throw 'Configuration is missing. Run Install.cmd, or copy the data folder from your previous installation.' }
    # Caller environment must not silently override the persisted credentials.
    $saved = @{}
    foreach ($key in @('DB_PASSWORD','DB_ROOT_PASSWORD','ADMIN_USERNAME','ADMIN_PASSWORD','PORT')) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    try {
        Invoke-Docker -Arguments (@('compose', '--project-name', 'marksix', '--project-directory', $Root, '--env-file', $config, '-f', (Join-Path $Root 'compose.yaml')) + $Arguments)
    } finally {
        foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    }
}

function Get-MarkSixUrl {
    param([string]$Root)
    $line = Get-Content -LiteralPath (Join-Path $Root 'data\.env') | Where-Object { $_ -match '^PORT=\d+$' } | Select-Object -Last 1
    if (-not $line) { throw 'PORT is missing or invalid in data\.env.' }
    return "http://127.0.0.1:$($line.Substring(5))"
}
