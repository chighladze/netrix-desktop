Set-StrictMode -Version Latest

function Assert-ReleaseTag([string] $Tag) {
    $Number = '(0|[1-9][0-9]*)'
    $PreId = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
    if ($Tag -cnotmatch "^v$Number\.$Number\.$Number(?:-$PreId(?:\.$PreId)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$") {
        throw "Release tag must be v<SemVer>; received '$Tag'."
    }
}

function Get-WindowsInstallerVariants([string] $Tag) {
    Assert-ReleaseTag $Tag
    $Prefix = 'Netrix_' + $Tag.Substring(1) + '_x64'
    [PSCustomObject]@{ Key = 'lightweight'; FileName = "$Prefix-lightweight-setup.exe"; Mode = 'embedBootstrapper' }
    [PSCustomObject]@{ Key = 'offlineFull'; FileName = "$Prefix-offline-full-setup.exe"; Mode = 'offlineInstaller' }
}

function Get-VerifiedReleasePackage([string] $Tag, [string] $ArtifactDirectory, [switch] $RequireVariants) {
    Assert-ReleaseTag $Tag
    $Root = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
    $Installers = @(Get-ChildItem -LiteralPath $Root -Recurse -Filter '*.exe' -File)
    $Manifests = @(Get-ChildItem -LiteralPath $Root -Recurse -Filter 'installer-hashes.sha256' -File)
    if ($Manifests.Count -ne 1) { throw 'Expected exactly one SHA256 manifest.' }
    if (@($Installers | Where-Object DirectoryName -ne $Root).Count -or $Manifests[0].DirectoryName -ne $Root) {
        throw 'Release assets must be at the artifact root.'
    }
    $Variants = @(Get-WindowsInstallerVariants $Tag)
    # Older release.json files describe one installer. A named variant always requires its sibling.
    if ($RequireVariants -or $Installers.Count -ne 1 -or $Installers[0].Name -in $Variants.FileName) {
        if ($Installers.Count -ne 2 -or @($Variants | Where-Object { $_.FileName -cnotin $Installers.Name }).Count) {
            throw 'Expected the Lightweight and Offline Full installers for this version.'
        }
    } else {
        $Variants = @([PSCustomObject]@{ Key = 'legacy'; FileName = $Installers[0].Name })
    }
    $Rows = @(Get-Content -LiteralPath $Manifests[0].FullName | Where-Object { $_ -and -not $_.StartsWith('#') })
    if ($Rows.Count -ne $Variants.Count) { throw 'Hash manifest must contain one row per installer.' }
    $Hashes = @{}
    foreach ($Row in $Rows) {
        if ($Row -cnotmatch '^([A-Fa-f0-9]{64})  ([^/\\\r\n]+)$') { throw 'Expected a SHA256 and a plain installer filename.' }
        if ($Matches[2] -cnotin $Variants.FileName -or $Hashes.ContainsKey($Matches[2])) { throw 'Invalid or duplicate manifest filename.' }
        $Hashes[$Matches[2]] = $Matches[1]
    }
    $Stable = $Tag -match '^v[0-9]+\.[0-9]+\.[0-9]+(?:\+.*)?$'
    $Assets = foreach ($Variant in $Variants) {
        $File = Get-Item -LiteralPath (Join-Path $Root $Variant.FileName)
        $Hash = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Hash -ne $Hashes[$File.Name]) { throw "Installer SHA256 does not match the manifest for $($File.Name)." }
        $Status = (Get-AuthenticodeSignature -LiteralPath $File.FullName).Status
        if ($Status -notin @('Valid', 'NotSigned')) { throw "Installer has an invalid signature: $Status." }
        if ($Stable -and $Status -ne 'Valid') { throw 'Stable releases require a valid Authenticode signature.' }
        [PSCustomObject]@{ Key = $Variant.Key; File = $File; Sha256 = $Hash; SigningStatus = if ($Status -eq 'Valid') { 'signed' } else { 'unsigned' } }
    }
    $Assets = @($Assets)
    if (@($Assets.SigningStatus | Sort-Object -Unique).Count -ne 1) { throw 'Both installers must have the same signing status.' }
    [PSCustomObject]@{
        Root = $Root
        Assets = $Assets
        Installer = $Assets[0].File
        Manifest = $Manifests[0]
        Sha256 = $Assets[0].Sha256
        Stable = $Stable
        SigningStatus = $Assets[0].SigningStatus
    }
}
