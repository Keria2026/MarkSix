param(
    [ValidateSet('Install','Start','Stop','Backup')][string]$Action = 'Start',
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'MarkSix'),
    [string]$AdminUsername = 'admin',
    [Security.SecureString]$AdminPassword,
    [switch]$NoBrowser
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$package = $PSScriptRoot
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$configPath = Join-Path $DataDirectory 'config.json'
function Write-PrivateText([string]$Path, [string]$Value) {
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}
function Protect-Data {
    [IO.Directory]::CreateDirectory($DataDirectory) | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $DataDirectory -AclObject $acl
}
# MySQL's Windows option parser does not reliably accept Unicode paths. Expose
# both runtime and persistent data through private, ASCII-only NTFS junctions.
# No data is copied, renamed or deleted; old installations keep their data.
function Initialize-AsciiPaths {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $base = [Environment]::GetFolderPath('CommonApplicationData')
    if ($base -match '[^\x20-\x7e]') { throw 'ProgramData must have an ASCII path for the MySQL compatibility bridge.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($DataDirectory.ToUpperInvariant() + '|' + $package.ToUpperInvariant())))).Replace('-','').Substring(0,24) } finally { $sha.Dispose() }
    $bridge = Join-Path (Join-Path (Join-Path $base 'MarkSix') $sid) $key
    [IO.Directory]::CreateDirectory($bridge) | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    }
    Set-Acl -LiteralPath $bridge -AclObject $acl
    foreach ($entry in @(@{name='data';target=$DataDirectory},@{name='runtime';target=(Join-Path $package 'mysql')})) {
        $link = Join-Path $bridge $entry.name
        if (Test-Path -LiteralPath $link) {
            $item = Get-Item -LiteralPath $link -Force
            if ($item.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath([string]$item.Target[0]).TrimEnd('\') -ne $entry.target.TrimEnd('\')) { throw "Unexpected path at $link; refusing to replace it." }
        } else { New-Item -ItemType Junction -Path $link -Target $entry.target | Out-Null }
    }
    $script:mysqlDataPath = Join-Path $bridge 'data'
    $script:mysqlRuntimePath = Join-Path $bridge 'runtime'
}
function Random-Hex {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Encrypt-Text([string]$Value) { return (ConvertTo-SecureString $Value -AsPlainText -Force | ConvertFrom-SecureString) }
function Decrypt-Text([string]$Value) {
    $secure = ConvertTo-SecureString $Value
    return (New-Object Net.NetworkCredential('', $secure)).Password
}
function Assert-Package {
    $manifest = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $package 'manifest.json') -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        $path = [IO.Path]::GetFullPath((Join-Path $package $entry.path))
        if (-not $path.StartsWith($package + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid manifest path.' }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Package damaged: $($entry.path). Extract the complete ZIP again." }
    }
}
function Get-OwnedProcess([string]$Name) {
    $recordPath = Join-Path $DataDirectory "$Name.process.json"
    if (-not (Test-Path -LiteralPath $recordPath)) { return $null }
    $record = Get-Content -Encoding UTF8 -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    if ($process.Path -ne $record.path -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.started) { throw "Process identity changed ($Name); refusing to stop or reuse it." }
    return $process
}
function Start-OwnedProcess([string]$Name, [string]$Exe, [string]$Arguments) {
    $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataDirectory "$Name.stdout.log") -RedirectStandardError (Join-Path $DataDirectory "$Name.stderr.log")
    $record = @{ id = $process.Id; path = $process.Path; started = $process.StartTime.ToUniversalTime().Ticks.ToString() }
    Write-PrivateText (Join-Path $DataDirectory "$Name.process.json") ($record | ConvertTo-Json)
    return $process
}
function Assert-PortFree([int]$Port) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() } catch { throw "Local port $Port is in use. Stop the conflicting application first." } finally { $listener.Stop() }
}
function Invoke-Database([string]$Tool, [string[]]$ToolArguments) {
    $clientPath = Join-Path $script:mysqlDataPath ('client-' + [guid]::NewGuid().ToString('N') + '.cnf')
    Write-PrivateText $clientPath "[client]`r`nhost=127.0.0.1`r`nport=33306`r`nuser=root`r`npassword=$script:rootPassword`r`nprotocol=tcp`r`n"
    try {
        # Windows PowerShell 5.1 treats native stderr as ErrorRecord objects.
        # Capture the complete diagnostic before checking the executable exit code.
        $savedPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = & (Join-Path $script:mysqlRuntimePath "bin\$Tool.exe") "--defaults-extra-file=$clientPath" @ToolArguments 2>&1
            $nativeExit = $LASTEXITCODE
        } finally { $ErrorActionPreference = $savedPreference }
        if ($nativeExit -ne 0) {
            $diagnostic = ($output | Out-String).Replace($script:rootPassword, '[redacted]').Replace($script:dbPassword, '[redacted]')
            throw "$Tool failed: $diagnostic"
        }
        return $output
    } finally { Remove-Item -LiteralPath $clientPath -Force -ErrorAction SilentlyContinue }
}
function Stop-Native {
    $app = Get-OwnedProcess 'app'
    if ($null -ne $app) { Stop-Process -Id $app.Id -ErrorAction Stop; $app.WaitForExit() }
    $db = Get-OwnedProcess 'mysql'
    if ($null -ne $db) {
        Invoke-Database 'mysqladmin' @('shutdown') | Out-Null
        if (-not $db.WaitForExit(60000)) { throw 'MySQL is still shutting down. Do not delete or move its data.' }
    }
}
function Start-Native {
    $mysqlExe = Join-Path $script:mysqlRuntimePath 'bin\mysqld.exe'
    $db = Get-OwnedProcess 'mysql'
    $app = Get-OwnedProcess 'app'
    if (($null -ne $db -and $db.Path -ne $mysqlExe -and $db.Path -ne (Join-Path $package 'mysql\bin\mysqld.exe')) -or ($null -ne $app -and $app.Path -ne (Join-Path $package 'marksix.exe'))) { throw 'An older package is running. Run its Stop.cmd before upgrading.' }
    if ($null -eq $app) { Assert-PortFree 8088 }
    $iniPath = Join-Path $script:mysqlDataPath 'mysql.ini'
    $base = $script:mysqlRuntimePath.Replace('\','/')
    $data = (Join-Path $script:mysqlDataPath 'mysql').Replace('\','/')
    $log = (Join-Path $script:mysqlDataPath 'mysql-error.log').Replace('\','/')
    Write-PrivateText $iniPath "[mysqld]`r`nbasedir=`"$base`"`r`ndatadir=`"$data`"`r`nlog-error=`"$log`"`r`nbind-address=127.0.0.1`r`nport=33306`r`nmysqlx=0`r`nskip-name-resolve`r`nlocal-infile=0`r`nmax-connections=24`r`ninnodb-buffer-pool-size=96M`r`nperformance-schema=OFF`r`n"
    $initialized = Join-Path $DataDirectory 'mysql-initialized'
    $provisioned = Join-Path $DataDirectory 'mysql-provisioned'
    if ($null -eq $db) {
        Assert-PortFree 33306
        if (-not (Test-Path -LiteralPath $initialized)) {
            if ((Test-Path -LiteralPath $data) -and @(Get-ChildItem -LiteralPath $data -Force).Count -gt 0) { throw 'Incomplete MySQL initialization. Preserve the data folder and inspect mysql-error.log before retrying.' }
            $init = Start-Process -FilePath $mysqlExe -ArgumentList "--defaults-file=`"$iniPath`" --initialize-insecure" -WindowStyle Hidden -PassThru -Wait
            if ($init.ExitCode -ne 0) { throw 'MySQL initialization failed. Check mysql-error.log and install the bundled VC runtime if needed.' }
            Write-PrivateText $initialized 'initialized'
        }
        $arguments = "--defaults-file=`"$iniPath`""
        if (-not (Test-Path -LiteralPath $provisioned)) {
            $bootstrapPath = Join-Path $script:mysqlDataPath 'bootstrap.sql'
            $sql = "ALTER USER 'root'@'localhost' IDENTIFIED BY '$script:rootPassword';`nCREATE DATABASE IF NOT EXISTS marksix CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`n"
            $sql += "CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '$script:rootPassword';`nGRANT ALL ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;`n"
            foreach ($hostName in @('localhost','127.0.0.1')) {
                $sql += "CREATE USER IF NOT EXISTS 'marksix'@'$hostName' IDENTIFIED BY '$script:dbPassword';`nGRANT ALL ON marksix.* TO 'marksix'@'$hostName';`n"
            }
            Write-PrivateText $bootstrapPath $sql
            $arguments += " --init-file=`"$bootstrapPath`""
        }
        $db = Start-OwnedProcess 'mysql' $mysqlExe $arguments
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($db.HasExited) { throw 'MySQL exited. Check mysql-error.log.' }
        try { Invoke-Database 'mysql' @('--batch','--skip-column-names','--execute=SELECT 1') | Out-Null; $ready = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw 'MySQL startup timed out. Check mysql-error.log.' }
    Write-PrivateText $provisioned 'provisioned'
    Remove-Item -LiteralPath (Join-Path $DataDirectory 'bootstrap.sql') -Force -ErrorAction SilentlyContinue
    if ($null -eq $app) {
        $values = @{
            DATABASE_URL = "mysql://marksix:$script:dbPassword@127.0.0.1:33306/marksix"
            ADMIN_USERNAME = $script:config.username
            ADMIN_PASSWORD = (Decrypt-Text $script:config.adminPassword)
            BIND_ADDR = '127.0.0.1:8088'
            FRONTEND_DIR = (Join-Path $package 'www')
            SECURE_COOKIE = 'false'
        }
        $previous = @{}
        try {
            foreach ($key in $values.Keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process') }
            $app = Start-OwnedProcess 'app' (Join-Path $package 'marksix.exe') '--serve'
        } finally { foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') } }
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($app.HasExited) { throw 'MarkSix exited. Check app.stderr.log and app.stdout.log.' }
        try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8088/api/health' -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw 'MarkSix startup timed out. Check the application logs.' }
    Write-Host 'MarkSix is ready: http://127.0.0.1:8088'
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8088' }
}
# Serialize lifecycle actions across double-clicks; the OS releases the mutex on failure.
$mutex = New-Object Threading.Mutex($false, 'Local\MarkSix-Native-Lifecycle')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another MarkSix install/start/stop/backup operation is running.' }
    if ($Action -in @('Install','Start')) { Assert-Package }
    if ($Action -eq 'Install' -and -not (Test-Path -LiteralPath $configPath)) {
        if ($AdminUsername -notmatch '^[A-Za-z0-9_.-]{1,80}$') { throw 'Invalid admin username.' }
        if ($null -eq $AdminPassword) {
            $AdminPassword = Read-Host 'Choose admin password (12+ characters)' -AsSecureString
            $confirm = Read-Host 'Repeat admin password' -AsSecureString
            if ((New-Object Net.NetworkCredential('', $AdminPassword)).Password -cne (New-Object Net.NetworkCredential('', $confirm)).Password) { throw 'Passwords do not match.' }
        }
        $plain = (New-Object Net.NetworkCredential('', $AdminPassword)).Password
        if (([Text.Encoding]::UTF32.GetByteCount($plain) / 4) -lt 12 -or [Text.Encoding]::UTF8.GetByteCount($plain) -gt 256) { throw 'Password must be at least 12 characters and at most 256 UTF-8 bytes.' }
        Protect-Data
        $newConfig = @{ version = 1; username = $AdminUsername; adminPassword = ($AdminPassword | ConvertFrom-SecureString); rootPassword = (Encrypt-Text (Random-Hex)); dbPassword = (Encrypt-Text (Random-Hex)) }
        Write-PrivateText $configPath ($newConfig | ConvertTo-Json)
        $plain = $null
    }
    if (-not (Test-Path -LiteralPath $configPath)) { throw 'Run Install.cmd first using this Windows user account.' }
    $script:config = Get-Content -Encoding UTF8 -LiteralPath $configPath -Raw | ConvertFrom-Json
    $script:rootPassword = Decrypt-Text $script:config.rootPassword
    $script:dbPassword = Decrypt-Text $script:config.dbPassword
    if ($script:rootPassword -notmatch '^[a-f0-9]{48}$' -or $script:dbPassword -notmatch '^[a-f0-9]{48}$') { throw 'Invalid database credentials in config.' }
    Initialize-AsciiPaths
    switch ($Action) {
        'Install' { Start-Native }
        'Start' { Start-Native }
        'Stop' { Stop-Native; Write-Host 'MarkSix stopped.' }
        'Backup' {
            if ($null -eq (Get-OwnedProcess 'mysql')) { throw 'Start MarkSix before creating a backup.' }
            $backupDirectory = Join-Path $DataDirectory 'backups'
            [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
            $destination = Join-Path $backupDirectory ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.sql')
            $temporary = Join-Path (Join-Path $script:mysqlDataPath 'backups') ([IO.Path]::GetFileName($destination) + '.partial')
            Invoke-Database 'mysqldump' @('--single-transaction','--routines','--triggers','--hex-blob','--no-tablespaces','--set-gtid-purged=OFF',"--result-file=$temporary",'--databases','marksix') | Out-Null
            Move-Item -LiteralPath $temporary -Destination $destination
            Write-Host "Backup: $destination"
        }
    }
} finally {
    $script:rootPassword = $null
    $script:dbPassword = $null
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
