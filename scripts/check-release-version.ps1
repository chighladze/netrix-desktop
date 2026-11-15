[CmdletBinding()]
param(
    [string] $Tag = $env:GITHUB_REF_NAME
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/windows-release.ps1')
Assert-ReleaseTag $Tag

$ExpectedVersion = $Tag.Substring(1)
if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    throw "Release tag '$Tag' does not contain a version."
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Read-JsonVersion([string] $RelativePath) {
    $Path = Join-Path $RepoRoot $RelativePath
    $Document = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string] $Document.version)) {
        throw "$RelativePath does not contain a version."
    }
    return [string] $Document.version
}

function Read-CargoPackageVersion([string] $RelativePath) {
    $Path = Join-Path $RepoRoot $RelativePath
    $InPackage = $false
    foreach ($Line in Get-Content -LiteralPath $Path) {
        $Trimmed = $Line.Trim()
        if ($Trimmed -eq "[package]") {
            $InPackage = $true
            continue
        }
        if ($InPackage -and $Trimmed.StartsWith("[")) {
            break
        }
        if ($InPackage -and $Trimmed -match '^version\s*=\s*"([^"]+)"$') {
            return $Matches[1]
        }
    }
    throw "$RelativePath does not contain package.version."
}

$Versions = [ordered]@{
    "package.json" = Read-JsonVersion "package.json"
    "frontend/package.json" = Read-JsonVersion "frontend/package.json"
    "src-tauri/tauri.conf.json" = Read-JsonVersion "src-tauri/tauri.conf.json"
    "backend-rs/Cargo.toml" = Read-CargoPackageVersion "backend-rs/Cargo.toml"
    "src-tauri/Cargo.toml" = Read-CargoPackageVersion "src-tauri/Cargo.toml"
}

foreach ($LockPath in @('package-lock.json', 'frontend/package-lock.json')) {
    # Node handles the empty packages[""] key on both Windows PowerShell and pwsh.
    $LockJson = & node -e 'const p = require(process.argv[1]); console.log(JSON.stringify({version:p.version,rootVersion:p.packages[String()].version}));' (Join-Path $RepoRoot $LockPath)
    if ($LASTEXITCODE -ne 0) { throw "Cannot read $LockPath." }
    $Lock = $LockJson | ConvertFrom-Json
    $Versions[$LockPath] = [string] $Lock.version
    $Versions["$LockPath packages root"] = [string] $Lock.rootVersion
}

foreach ($CargoPackage in @(@('backend-rs', 'netrix-backend'), @('src-tauri', 'netrix'))) {
    $CargoLockPath = "$($CargoPackage[0])/Cargo.lock"
    $CargoLock = Get-Content -LiteralPath (Join-Path $RepoRoot $CargoLockPath) -Raw
    $Pattern = '(?m)^name = "' + [regex]::Escape($CargoPackage[1]) + '"\r?\nversion = "([^"]+)"'
    if ($CargoLock -notmatch $Pattern) { throw "Missing package version in $CargoLockPath." }
    $Versions[$CargoLockPath] = $Matches[1]
}

$Mismatches = @($Versions.GetEnumerator() | Where-Object { $_.Value -cne $ExpectedVersion })
if ($Mismatches.Count -gt 0) {
    $Details = ($Mismatches | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "
    throw "Tag $Tag expects version $ExpectedVersion, but version files differ: $Details"
}

Write-Host "Release tag $Tag matches all project version files."
