param([string]$PackageDirectory = 'windows-native-package')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$package = [IO.Path]::GetFullPath($PackageDirectory)
# Test real paths containing spaces, with persistent data outside the package.
$testRoot = Join-Path $env:RUNNER_TEMP ('MarkSix native test ' + [guid]::NewGuid().ToString('N'))
$testData = Join-Path $testRoot 'persistent data'
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
    $bootstrap = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/bootstrap' -WebSession $session
    Assert ($bootstrap.plays.Count -ge 3) 'Database initialization failed.'
    $quoteBody = @{period=$bootstrap.today.id; play_id=$bootstrap.plays[2].id; play_version=1; selections=@(6,0,1,2,3,4,5); compound=$true; amount='100'; request_id=[guid]::NewGuid().ToString()} | ConvertTo-Json
    $quote = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/quote' -Method Post -WebSession $session -Headers @{'X-Marksix'='1'} -ContentType 'application/json' -Body $quoteBody
    Assert ($quote.units -eq 21 -and $quote.stake -eq 210000) 'Native 7-choose-5 quote or cent accounting failed.'
    $before = Get-Content -LiteralPath (Join-Path $testData 'config.json') -Raw
    Assert (-not $before.Contains($password)) 'Plaintext password leaked into config.'
    & $scriptPath -Action Start -DataDirectory $testData -NoBrowser
    & $scriptPath -Action Backup -DataDirectory $testData
    $backup = @(Get-ChildItem -LiteralPath (Join-Path $testData 'backups') -Filter '*.sql')
    Assert ($backup.Count -eq 1 -and $backup[0].Length -gt 1000) 'Backup is missing or empty.'
    Assert ((Get-Content -LiteralPath $backup[0].FullName -Raw) -match 'CREATE TABLE') 'Backup does not contain schema.'
    & $scriptPath -Action Stop -DataDirectory $testData
    & $scriptPath -Action Install -DataDirectory $testData -NoBrowser
    # Reuse the pre-restart session to prove persisted database state, not just defaults.
    $again = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/bootstrap' -WebSession $session
    Assert ($again.plays[2].id -eq $bootstrap.plays[2].id) 'Database did not persist across restart.'
    Assert ((Get-Content -LiteralPath (Join-Path $testData 'config.json') -Raw) -ceq $before) 'Reinstall overwrote credentials.'
    Write-Host 'Native Windows installation, login, frontend, quote, restart and backup passed.'
} catch {
    foreach ($log in @('mysql-error.log','app.stderr.log','app.stdout.log')) {
        $path = Join-Path $testData $log
        if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Tail 35 | Write-Host }
    }
    throw
} finally {
    if (Test-Path -LiteralPath (Join-Path $testData 'config.json')) { & $scriptPath -Action Stop -DataDirectory $testData }
}
