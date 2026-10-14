# Runs on Windows PowerShell 5.1 and PowerShell 7 in GitHub Actions.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'deploy\windows'
foreach ($file in Get-ChildItem $source -Filter '*.ps1') {
    $tokens = $null; $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw ($errors | Out-String) }
}
. (Join-Path $source 'Common.ps1')
function Assert-True { param([bool]$Value, [string]$Message); if (-not $Value) { throw $Message } }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('MarkSix package test ' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    $config = Join-Path $temporary 'data\.env'
    New-MarkSixConfig -Path $config -Username 'test-admin' -Password 'Test-$-Password-123'
    $original = [IO.File]::ReadAllBytes($config)
    $content = [IO.File]::ReadAllText($config)
    Assert-True ($original[0] -eq 68) 'Configuration must use UTF-8 without BOM'
    Assert-True ($content.Contains("ADMIN_PASSWORD='Test-`$-Password-123'")) 'Password must be quoted literally'
    Assert-True ((Get-MarkSixUrl -Root $temporary) -eq 'http://127.0.0.1:8088') 'Port URL mismatch'
    Assert-True ((Get-Acl (Split-Path $config)).AreAccessRulesProtected) 'Private configuration must not inherit access rules'
    New-MarkSixConfig -Path $config -Username 'different' -Password 'different-password'
    Assert-True ([IO.File]::ReadAllText($config) -ceq $content) 'Reinstallation changed credentials'
    $hex = New-RandomHex
    Assert-True ($hex -cmatch '^[a-f0-9]{48}$') 'Database password format invalid'
    Assert-True ($hex -cne (New-RandomHex)) 'Random credentials were reused'
    foreach ($password in @('short', "contains'quote123", 'contains\slash123')) {
        $rejected = $false
        try { New-MarkSixConfig -Path (Join-Path $temporary 'invalid\.env') -Username 'admin' -Password $password } catch { $rejected = $true }
        Assert-True $rejected 'Invalid password accepted'
    }
    $files = @('Common.ps1','Install.ps1','Manage.ps1','Install.cmd','Start.cmd','Stop.cmd','Backup.cmd','README.txt','compose.yaml','images.tar.gz')
    $hashes = @{}
    foreach ($name in $files) {
        $path = Join-Path $temporary $name
        [IO.File]::WriteAllText($path, 'checksum fixture')
        $hashes[$name] = (Get-FileHash $path -Algorithm SHA256).Hash
    }
    @{schema=1;platform='linux/amd64';files=$hashes} | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $temporary 'manifest.json') -Encoding UTF8
    Assert-Package -Root $temporary
    [IO.File]::WriteAllText((Join-Path $temporary 'compose.yaml'), 'corrupted')
    $rejected = $false
    try { Assert-Package -Root $temporary } catch { $rejected = $true }
    Assert-True $rejected 'Corrupted package accepted'

    function docker { $global:LASTEXITCODE = 19 }
    $rejected = $false
    try { Invoke-Docker -Arguments @('info') } catch { $rejected = $true }
    Assert-True $rejected 'Docker error was ignored'
    $saved = $env:DB_PASSWORD
    $env:DB_PASSWORD = 'must-not-override'
    function docker {
        if ($env:DB_PASSWORD) { throw 'Caller environment leaked into Compose configuration' }
        $global:LASTEXITCODE = 0
    }
    Invoke-MarkSixCompose -Root $temporary -Arguments @('ps')
    Assert-True ($env:DB_PASSWORD -eq 'must-not-override') 'Caller environment was not restored'
    $env:DB_PASSWORD = $saved
    Remove-Item Function:\docker
    Write-Host 'Windows script checks passed: parsing, credentials, ACL, repeat installation, checksum, failure propagation, environment isolation.'
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
