[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Tag,
    [Parameter(Mandatory)][string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/windows-release.ps1')
Assert-ReleaseTag $Tag
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = $Tag.Substring(1)
$shell = Get-Item -LiteralPath (Join-Path $root 'src-tauri/target/release/netrix.exe')
$backend = Get-Item -LiteralPath (Join-Path $root 'src-tauri/binaries/netrix_backend-x86_64-pc-windows-msvc.exe')
$statuses = @(foreach ($binary in @($shell, $backend)) {
    if ($binary.VersionInfo.ProductVersion -cne $version -or $binary.VersionInfo.ProductName -cne 'Netrix') {
        throw "Wrong Netrix product or version in $($binary.Name)."
    }
    (Get-AuthenticodeSignature -LiteralPath $binary.FullName).Status.ToString()
})
if ($statuses[0] -ne $statuses[1] -or $statuses[0] -notin @('Valid', 'NotSigned') -or
    ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+-' -and $statuses[0] -ne 'Valid')) {
    throw 'Expected matching and release-appropriate signatures on both Portable executables.'
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$destination = Join-Path (Resolve-Path -LiteralPath $OutputDirectory).Path (Get-WindowsPortableName $Tag)
$temporary = "$destination.$([guid]::NewGuid().ToString('N')).tmp"
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($temporary, 'Create')
    try {
        # Never enumerate a working/profile directory when building a public archive.
        foreach ($entry in @(@('Netrix.exe', $shell.FullName), @('netrix_backend.exe', $backend.FullName), @('LICENSE', (Join-Path $root 'LICENSE')))) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entry[1], $entry[0], 'Optimal')
        }
        [void]$zip.CreateEntry('Netrix.portable')
        [void]$zip.CreateEntry('Data/')
    } finally { $zip.Dispose() }
    [IO.File]::Move($temporary, $destination)
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
Get-Item -LiteralPath $destination
