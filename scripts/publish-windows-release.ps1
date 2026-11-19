[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Tag,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string] $Repository,
    [string] $ArtifactDirectory = 'release-artifacts',
    [switch] $RequireVariants
)

# Kept under the existing filename for callers; this command creates a DRAFT only.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'lib/windows-release.ps1')
$Package = Get-VerifiedReleasePackage $Tag $ArtifactDirectory -RequireVariants:$RequireVariants
$MetadataPath = Join-Path $Package.Root 'release.json'
$NotesPath = Join-Path $Package.Root 'release-notes.md'
$Metadata = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
$ExpectedSchema = if ($Package.Assets.Count -eq 2) { 2 } else { 1 }
if ($Metadata.schemaVersion -ne $ExpectedSchema -or $Metadata.tag -cne $Tag -or
    $Metadata.version -cne $Tag.Substring(1) -or $Metadata.platform -cne 'windows-x86_64' -or
    $Metadata.fileName -cne $Package.Installer.Name -or $Metadata.size -ne $Package.Installer.Length -or
    $Metadata.sha256 -ne $Package.Sha256 -or $Metadata.signingStatus -cne $Package.SigningStatus -or
    $Metadata.sourceCommit -cnotmatch '^[a-f0-9]{40}$') {
    throw 'Release metadata does not match the verified installer.'
}
if ($Package.Assets.Count -eq 2) {
    if (@($Metadata.installers.PSObject.Properties).Count -ne 2) { throw 'Expected metadata for both installers.' }
    foreach ($Asset in $Package.Assets) {
        $Entry = $Metadata.installers.PSObject.Properties[$Asset.Key]
        if (-not $Entry -or $Entry.Value.fileName -cne $Asset.File.Name -or $Entry.Value.size -ne $Asset.File.Length -or
            $Entry.Value.sha256 -ne $Asset.Sha256 -or $Entry.Value.signingStatus -cne $Asset.SigningStatus) {
            throw "Release metadata does not match $($Asset.Key)."
        }
    }
}
if (-not (Test-Path -LiteralPath $NotesPath -PathType Leaf)) { throw 'Release notes are missing.' }
if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN)) { throw 'RELEASES_TOKEN/GH_TOKEN must be configured for the public releases repository.' }

$RepoJson = & gh api "repos/$Repository"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read target repository; check token scope and repository name.' }
$Repo = $RepoJson | ConvertFrom-Json
if ($Repo.private -or $Repo.full_name -ine $Repository) { throw 'The release destination must be the selected public distribution repository.' }
if ($env:GITHUB_REPOSITORY -and $Repository -ieq $env:GITHUB_REPOSITORY) {
    throw 'The public distribution repository must differ from the private source repository.'
}

# A failed list is an error, not evidence that a release is absent.
$ReleasesJson = & gh release list --repo $Repository --limit 1000 --json tagName,isDraft
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing releases.' }
if (@($ReleasesJson | ConvertFrom-Json | Where-Object { $_.tagName -ceq $Tag }).Count -gt 0) {
    throw "Release $Tag already exists. Inspect it explicitly; this script never replaces published or draft assets."
}
$Assets = @($Package.Assets | ForEach-Object { $_.File.FullName }) + @($Package.Manifest.FullName, $MetadataPath)
$CreateArgs = @('release', 'create', $Tag) + $Assets + @(
    '--repo', $Repository, '--target', $Repo.default_branch,
    '--draft', '--title', "Netrix $($Metadata.version)", '--notes-file', $NotesPath
)
if (-not $Package.Stable) { $CreateArgs += '--prerelease' }
& gh @CreateArgs
if ($LASTEXITCODE -ne 0) { throw 'Draft creation/upload failed. Inspect the draft before retrying; it has not been published.' }

$ResultJson = & gh release view $Tag --repo $Repository --json isDraft,isPrerelease,tagName,assets,url
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the uploaded draft.' }
$Result = $ResultJson | ConvertFrom-Json
if (-not $Result.isDraft -or $Result.tagName -cne $Tag -or $Result.isPrerelease -eq $Package.Stable) {
    throw 'Unexpected draft/tag/prerelease state.'
}
if (@($Result.assets).Count -ne $Assets.Count) { throw 'Draft assets are incomplete or unexpected.' }
foreach ($AssetPath in $Assets) {
    $File = Get-Item -LiteralPath $AssetPath
    $Uploaded = @($Result.assets | Where-Object { $_.name -ceq $File.Name -and $_.size -eq $File.Length })
    if ($Uploaded.Count -ne 1) { throw "Missing or incomplete uploaded asset: $($File.Name)." }
}
Write-Host "Created verified draft: $($Result.url). Complete exact-installer QA before publishing."
