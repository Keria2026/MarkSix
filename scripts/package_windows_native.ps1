param([string]$Destination = 'windows-native-package')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Package destination must not already exist.' }
New-Item -ItemType Directory -Path $destinationPath | Out-Null
Get-ChildItem deploy/windows-native -File | Where-Object { $_.Extension -in @('.cmd','.ps1','.md') } | Copy-Item -Destination $destinationPath
Copy-Item backend/target/release/marksix.exe $destinationPath
Copy-Item docs/LICENSING.md (Join-Path $destinationPath 'LICENSING.md')
Copy-Item frontend/dist (Join-Path $destinationPath 'www') -Recurse
New-Item -ItemType Directory -Path (Join-Path $destinationPath 'fixtures') | Out-Null
Copy-Item fixtures/customer-plays.json (Join-Path $destinationPath 'fixtures/customer-plays.json')
$mysqlUrl = 'https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.11-winx64.zip'
$download = Join-Path $env:RUNNER_TEMP 'mysql-native.zip'
Invoke-WebRequest -Uri $mysqlUrl -OutFile $download
$downloadHash = (Get-FileHash $download -Algorithm SHA256).Hash
$expanded = Join-Path $env:RUNNER_TEMP 'mysql-native-expanded'
Expand-Archive -LiteralPath $download -DestinationPath $expanded
Move-Item (Join-Path $expanded 'mysql-8.4.11-winx64') (Join-Path $destinationPath 'mysql')
$runtime = Join-Path $destinationPath 'vc_redist.x64.exe'
Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $runtime
$signature = Get-AuthenticodeSignature -LiteralPath $runtime
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'VC runtime signature validation failed.' }
$files = @(Get-ChildItem -LiteralPath $destinationPath -File -Recurse | ForEach-Object {
    @{ path = $_.FullName.Substring($destinationPath.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$manifest = @{ schema = 1; platform = 'windows-x64-native'; commit = $env:GITHUB_SHA; mysqlSource = $mysqlUrl; mysqlArchiveSha256 = $downloadHash; files = $files }
[IO.File]::WriteAllText((Join-Path $destinationPath 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
