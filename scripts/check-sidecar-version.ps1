[CmdletBinding()]
param([Parameter(Mandatory)][string] $BinaryPath)

$ErrorActionPreference = 'Stop'
$Config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../src-tauri/tauri.conf.json') | ConvertFrom-Json
$File = Get-Item -LiteralPath $BinaryPath
$VersionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($File.FullName)
$Expected = [ordered]@{ ProductName = $Config.productName; ProductVersion = $Config.version }

foreach ($Field in $Expected.Keys) {
    $Actual = $VersionInfo.$Field
    if ([string]::IsNullOrWhiteSpace($Actual) -or $Actual -cne $Expected[$Field]) {
        throw "$($File.Name) has $Field='$Actual'. Expected '$($Expected[$Field])'."
    }
    Write-Output "$($File.Name) $Field='$Actual'"
}
