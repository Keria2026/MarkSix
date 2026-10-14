[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Start','Stop','Status','Backup')][string]$Action)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    Assert-DockerDesktop
    switch ($Action) {
        'Start' {
            Invoke-MarkSixCompose -Root $PSScriptRoot -Arguments @('up','-d','--no-build','--pull','never','--wait','--wait-timeout','180')
            Start-Process (Get-MarkSixUrl -Root $PSScriptRoot)
        }
        'Stop' { Invoke-MarkSixCompose -Root $PSScriptRoot -Arguments @('stop') }
        'Status' { Invoke-MarkSixCompose -Root $PSScriptRoot -Arguments @('ps') }
        'Backup' {
            $directory = Join-Path $PSScriptRoot 'data\backups'
            Protect-Directory -Path $directory
            $name = 'marksix-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.sql'
            $remote = '/tmp/' + $name
            $local = Join-Path $directory $name
            $dump = 'umask 077; MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --no-tablespaces --single-transaction --routines --triggers -u marksix marksix > ' + $remote
            try {
                Invoke-MarkSixCompose -Root $PSScriptRoot -Arguments @('exec','-T','db','sh','-c',$dump)
                Invoke-MarkSixCompose -Root $PSScriptRoot -Arguments @('cp',('db:' + $remote),$local)
                if ((Get-Item -LiteralPath $local).Length -eq 0) { throw 'The backup is empty.' }
                Write-Host "Backup saved: $local"
            } finally {
                Invoke-MarkSixCompose -Root $PSScriptRoot -Arguments @('exec','-T','db','rm','-f',$remote)
            }
        }
    }
} catch { Write-Host "Operation failed: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
