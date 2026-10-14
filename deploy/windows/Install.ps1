[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port = 8088, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    Assert-DockerDesktop
    Write-Host 'Checking package checksums...'
    Assert-Package -Root $PSScriptRoot
    $config = Join-Path $PSScriptRoot 'data\.env'
    if (-not (Test-Path -LiteralPath $config)) {
        $volume = Invoke-Docker -Arguments @('volume','ls','--filter','name=^marksix_mysql-data$','--format','{{.Name}}')
        if ($volume) { throw 'An existing MarkSix database was found. Copy your previous data folder into this package before installing. Do not delete the database volume.' }
        $username = Read-Host 'Administrator account [admin]'
        if ([string]::IsNullOrWhiteSpace($username)) { $username = 'admin' }
        $secure = Read-Host 'Administrator password (at least 12 characters)' -AsSecureString
        $confirm = Read-Host 'Confirm administrator password' -AsSecureString
        $password = (New-Object Net.NetworkCredential('', $secure)).Password
        $confirmation = (New-Object Net.NetworkCredential('', $confirm)).Password
        try {
            if ($password -cne $confirmation) { throw 'Passwords do not match.' }
            New-MarkSixConfig -Path $config -Username $username -Password $password -Port $Port
        } finally {
            $password = $null; $confirmation = $null
            $secure.Dispose(); $confirm.Dispose()
        }
    } else { Write-Host 'Keeping the existing account and database passwords.' }
    Write-Host 'Loading the included images (no image download required)...'
    Invoke-Docker -Arguments @('load','--input',(Join-Path $PSScriptRoot 'images.tar.gz'))
    Invoke-MarkSixCompose -Root $PSScriptRoot -Arguments @('up','-d','--no-build','--pull','never','--wait','--wait-timeout','180')
    $url = Get-MarkSixUrl -Root $PSScriptRoot
    Write-Host "MarkSix is ready: $url"
    if (-not $NoBrowser) { Start-Process $url }
} catch { Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
