[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Tag,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string] $SourceCommit,
    [string] $BuildUrl = '',
    [string] $ArtifactDirectory = 'release-artifacts'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/windows-release.ps1')
& (Join-Path $PSScriptRoot 'check-release-version.ps1') -Tag $Tag
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Version = $Tag.Substring(1)
$Bundle = Join-Path $RepoRoot "src-tauri/target/release/bundle/windows-installers/$Version"
$Installers = @(Get-WindowsInstallerVariants $Tag | ForEach-Object { Join-Path $Bundle $_.FileName })
if ((Test-Path -LiteralPath $ArtifactDirectory) -and @(Get-ChildItem -LiteralPath $ArtifactDirectory -Force).Count -gt 0) {
    throw 'Artifact directory must be empty; do not reuse files from another build.'
}
& (Join-Path $PSScriptRoot 'sign-windows-bundle.ps1') -Tag $Tag -InstallerPath $Installers
New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
Copy-Item -LiteralPath ($Installers + (Join-Path $Bundle 'installer-hashes.sha256')) -Destination $ArtifactDirectory
$Package = Get-VerifiedReleasePackage $Tag $ArtifactDirectory -RequireVariants
$Downloads = [ordered]@{}
foreach ($Asset in $Package.Assets) {
    $Downloads[$Asset.Key] = [ordered]@{
        fileName = $Asset.File.Name
        size = $Asset.File.Length
        sha256 = $Asset.Sha256
        signingStatus = $Asset.SigningStatus
    }
}
$Metadata = [ordered]@{
    schemaVersion = 2
    tag = $Tag
    version = $Tag.Substring(1)
    platform = 'windows-x86_64'
    fileName = $Package.Installer.Name
    size = $Package.Installer.Length
    sha256 = $Package.Sha256
    signingStatus = $Package.SigningStatus
    installers = $Downloads
    sourceCommit = $SourceCommit
    builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    buildUrl = $BuildUrl
}
$Metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Package.Root 'release.json') -Encoding UTF8
$SignatureNote = if ($Package.SigningStatus -eq 'signed') {
    'The shell, backend sidecar and both installers have verified timestamped Authenticode signatures.'
} else {
    'This is an unsigned prerelease. Windows may display an unknown-publisher warning.'
}
$Notes = @"
Netrix $($Metadata.version) for Windows x64.

$SignatureNote

**Lightweight** is the recommended download for Windows x64. It uses the installed WebView2 runtime, or downloads it from Microsoft when necessary.

- $($Downloads.lightweight.fileName) ($($Downloads.lightweight.size) bytes)
- SHA-256: $($Downloads.lightweight.sha256)

**Offline Full** includes Microsoft Evergreen WebView2 for disconnected PCs. Both installers contain the same Netrix application and support upgrades from earlier releases.

- $($Downloads.offlineFull.fileName) ($($Downloads.offlineFull.size) bytes)
- SHA-256: $($Downloads.offlineFull.sha256)

- Source commit: $SourceCommit
- Automated checks: the complete Netrix release gate passed before this package was prepared.

Before publishing, record clean-profile installer/runtime checks for both SHA-256 values using docs/build_instructions.md.
"@
$Notes | Set-Content -LiteralPath (Join-Path $Package.Root 'release-notes.md') -Encoding UTF8
Write-Host "Prepared $($Metadata.fileName), SHA256 $($Metadata.sha256), signing: $($Metadata.signingStatus)."
if ($env:GITHUB_STEP_SUMMARY) {
    $Notes | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
}
