param([string]$PackageDirectory = 'windows-native-package')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$package = [IO.Path]::GetFullPath($PackageDirectory)
# Construct Unicode explicitly so Windows PowerShell 5.1 can read this ASCII script.
$chinese = -join @([char]0x4e2d,[char]0x6587,[char]0x7528,[char]0x6237)
$unicodePackage = Join-Path ([IO.Path]::GetDirectoryName($package)) ($chinese + ' installation')
Move-Item -LiteralPath $package -Destination $unicodePackage
$originalPackage = $package
$package = $unicodePackage
# Test package and data under Chinese paths, including backup and restart.
$testRoot = Join-Path $env:RUNNER_TEMP ('MarkSix native test ' + [guid]::NewGuid().ToString('N'))
$testData = Join-Path $testRoot ($chinese + ' persistent data')
$scriptPath = Join-Path $package 'Manage.ps1'
$password = [guid]::NewGuid().ToString('N')
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Login {
    $body = @{username='native-test';password=$password} | ConvertTo-Json
    Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8088/api/login' -Method Post -Headers @{'X-Marksix'='1'} -ContentType 'application/json' -Body $body -SessionVariable session | Out-Null
    return $session
}
try {
    & $scriptPath -Action Install -DataDirectory $testData -AdminUsername 'native-test' -AdminPassword $securePassword -NoBrowser
    $session = Login
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8088/'
    Assert ($response.Content -match '<html') 'Static frontend was not served.'
    Assert ($response.Headers['Content-Security-Policy'] -match "frame-ancestors 'none'") 'Missing native CSP.'
    $license = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/license' -WebSession $session
    Assert (-not $license.active -and $license.binding.Length -eq 64) 'Native application must require device/account activation.'
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/bootstrap' -WebSession $session | Out-Null; throw 'Unlicensed business API was accessible.' }
    catch { if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 402) { throw } }
    $before = Get-Content -LiteralPath (Join-Path $testData 'config.json') -Raw
    Assert (-not $before.Contains($password)) 'Plaintext password leaked into config.'
    # Regression: old Start-Process records could have a null module path.
    $appRecordPath=Join-Path $testData 'app.process.json'
    $appRecord=Get-Content -Encoding UTF8 -LiteralPath $appRecordPath -Raw | ConvertFrom-Json
    $appRecord.path=$null
    $appRecord | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $appRecordPath
    & $scriptPath -Action Start -DataDirectory $testData -NoBrowser
    & $scriptPath -Action Backup -DataDirectory $testData
    $backup = @(Get-ChildItem -LiteralPath (Join-Path $testData 'backups') -Filter '*.sql')
    Assert ($backup.Count -eq 1 -and $backup[0].Length -gt 1000) 'Backup is missing or empty.'
    Assert ((Get-Content -LiteralPath $backup[0].FullName -Raw) -match 'CREATE TABLE') 'Backup does not contain schema.'
    # A missing app PID and reused database PID must not prevent authenticated shutdown,
    # and must never kill this PowerShell test process.
    Remove-Item -LiteralPath (Join-Path $testData 'app.process.json')
    $self = Get-Process -Id $PID
    @{id=$PID;path=$self.Path;started='stale'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testData 'mysql.process.json') -Encoding UTF8
    & $scriptPath -Action Stop -DataDirectory $testData
    foreach ($port in @(8088,33306)) {
        $client=New-Object Net.Sockets.TcpClient
        try { $open=$client.ConnectAsync('127.0.0.1',$port).Wait(500) -and $client.Connected; Assert (-not $open) "Port $port remained open after Stop." } catch [System.Management.Automation.MethodInvocationException] { } finally { $client.Dispose() }
    }
    & $scriptPath -Action Stop -DataDirectory $testData
    & $scriptPath -Action Install -DataDirectory $testData -NoBrowser
    $again = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/session' -WebSession $session
    Assert ($again.username -eq 'native-test') 'Database/session did not persist across restart.'
    # Restore a portable .sql.gz dump: preserve the old session, remove a newer one.
    $newerSession = Login
    $compressed = Join-Path $testRoot 'portable backup.sql.gz'
    $inputStream=[IO.File]::OpenRead($backup[0].FullName)
    $outputStream=[IO.File]::Create($compressed)
    $gzip=New-Object IO.Compression.GZipStream($outputStream,[IO.Compression.CompressionMode]::Compress)
    try { $inputStream.CopyTo($gzip) } finally { $gzip.Dispose();$outputStream.Dispose();$inputStream.Dispose() }
    & $scriptPath -Action Restore -DataDirectory $testData -BackupFile $compressed -ConfirmRestore -NoBrowser
    $restored = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/session' -WebSession $session
    Assert ($restored.username -eq 'native-test') 'Restored SQL did not recover the original session.'
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/session' -WebSession $newerSession | Out-Null; throw 'Restore retained a session created after the backup.' }
    catch { if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw } }
    Assert ((Get-Content -LiteralPath (Join-Path $testData 'config.json') -Raw) -ceq $before) 'Reinstall overwrote credentials.'
    Write-Host 'Native Windows installation, activation gate, stale PID shutdown, idempotent stop, persistence, backup and restore passed.'
} catch {
    foreach ($log in @('mysql-error.log','app.stderr.log','app.stdout.log')) {
        $path = Join-Path $testData $log
        if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Tail 35 | Write-Host }
    }
    throw
} finally {
    if (Test-Path -LiteralPath (Join-Path $testData 'config.json')) {
        try { & $scriptPath -Action Stop -DataDirectory $testData } catch { Write-Warning "Cleanup failed: $_" }
    }
    Move-Item -LiteralPath $package -Destination $originalPackage
}
