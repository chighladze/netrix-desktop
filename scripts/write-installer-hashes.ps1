[CmdletBinding()]
param(
    [string[]] $Patterns = @(
        "src-tauri/target/release/bundle/nsis/*.exe"
    ),
    [string] $OutputPath = "src-tauri/target/release/bundle/installer-hashes.sha256"
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Files = foreach ($Pattern in $Patterns) {
    Get-ChildItem -Path (Join-Path $RepoRoot $Pattern) -File -ErrorAction SilentlyContinue
}

$Files = @($Files | Sort-Object FullName -Unique)
if ($Files.Count -ne 1) {
    throw "Expected exactly one publishable NSIS installer, found $($Files.Count). Run 'npm run build' first and verify bundle targets."
}

$Rows = foreach ($File in $Files) {
    $Hash = Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName
    $RepoRootWithSeparator = $RepoRoot
    if (-not $RepoRootWithSeparator.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $RepoRootWithSeparator = "$RepoRootWithSeparator$([System.IO.Path]::DirectorySeparatorChar)"
    }
    $RelativePath = [Uri]::UnescapeDataString(
        ([Uri] $RepoRootWithSeparator).MakeRelativeUri([Uri] $File.FullName).ToString()
    )
    [PSCustomObject]@{
        Algorithm = "SHA256"
        Hash = $Hash.Hash
        Path = $RelativePath
    }
}

$OutputFullPath = Join-Path $RepoRoot $OutputPath
$OutputDirectory = Split-Path -Parent $OutputFullPath
if ($OutputDirectory) {
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
}

$Lines = @(
    "# Netrix installer SHA256 hashes",
    "# Generated: $((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))",
    ""
)

foreach ($Row in $Rows) {
    $Lines += "$($Row.Hash)  $($Row.Path)"
}

Set-Content -LiteralPath $OutputFullPath -Value $Lines -Encoding ASCII

$Rows | Format-Table -AutoSize
Write-Host "Saved installer hashes to $OutputPath"
