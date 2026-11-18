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
$Installers = @(Get-ChildItem -Path (Join-Path $RepoRoot 'src-tauri/target/release/bundle/nsis/*.exe') -File)
if ($Installers.Count -ne 1) { throw 'Expected exactly one NSIS installer from the release gate.' }
if ((Test-Path -LiteralPath $ArtifactDirectory) -and @(Get-ChildItem -LiteralPath $ArtifactDirectory -Force).Count -gt 0) {
    throw 'Artifact directory must be empty; do not reuse files from another build.'
}
& (Join-Path $PSScriptRoot 'sign-windows-bundle.ps1') -Tag $Tag -InstallerPath $Installers[0].FullName
New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
$ArtifactInstaller = Join-Path $ArtifactDirectory $Installers[0].Name
Copy-Item -LiteralPath $Installers[0].FullName -Destination $ArtifactInstaller
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArtifactInstaller).Hash
"$Hash  $($Installers[0].Name)" | Set-Content -LiteralPath (Join-Path $ArtifactDirectory 'installer-hashes.sha256') -Encoding ascii
$Package = Get-VerifiedReleasePackage $Tag $ArtifactDirectory
$Metadata = [ordered]@{
    schemaVersion = 1
    tag = $Tag
    version = $Tag.Substring(1)
    platform = 'windows-x86_64'
    fileName = $Package.Installer.Name
    size = $Package.Installer.Length
    sha256 = $Package.Sha256
    signingStatus = $Package.SigningStatus
    sourceCommit = $SourceCommit
    builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    buildUrl = $BuildUrl
}
$Metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Package.Root 'release.json') -Encoding UTF8
$SignatureNote = if ($Package.SigningStatus -eq 'signed') {
    'The shell, backend sidecar and installer have verified timestamped Authenticode signatures.'
} else {
    'This is an unsigned prerelease. Windows may display an unknown-publisher warning.'
}
$Notes = @"
Netrix $($Metadata.version) for Windows x64.

$SignatureNote

Download the EXE from Assets. The source-code archives in this distribution repository contain release documentation, not the application source or installer.

- Installer: $($Metadata.fileName)
- SHA-256: $($Metadata.sha256)
- Source commit: $SourceCommit
- Automated checks: the complete Netrix release gate passed before this package was prepared.

Windows packaging uses a statically linked backend CRT and the full offline Microsoft Evergreen WebView2 installer. Setup checks WebView2 through the application loader, attempts offline recovery when unavailable, and stops if the repeated check fails. The release gate checks DLL imports and read-only startup probes; a hosted runner is not a clean-machine installation test.

Before publishing this draft, complete and record the clean-profile installer/runtime checks using docs/build_instructions.md for this exact SHA-256. Automated build checks do not establish manual runtime QA.
"@
$Notes | Set-Content -LiteralPath (Join-Path $Package.Root 'release-notes.md') -Encoding UTF8
Write-Host "Prepared $($Metadata.fileName), SHA256 $($Metadata.sha256), signing: $($Metadata.signingStatus)."
if ($env:GITHUB_STEP_SUMMARY) {
    $Notes | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
}
