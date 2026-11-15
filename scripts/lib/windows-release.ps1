Set-StrictMode -Version Latest

function Assert-ReleaseTag([string] $Tag) {
    $Number = '(0|[1-9][0-9]*)'
    $PreId = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
    if ($Tag -cnotmatch "^v$Number\.$Number\.$Number(?:-$PreId(?:\.$PreId)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$") {
        throw "Release tag must be v<SemVer>; received '$Tag'."
    }
}

function Get-VerifiedReleasePackage([string] $Tag, [string] $ArtifactDirectory) {
    Assert-ReleaseTag $Tag
    $Root = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
    $Installers = @(Get-ChildItem -LiteralPath $Root -Recurse -Filter '*.exe' -File)
    $Manifests = @(Get-ChildItem -LiteralPath $Root -Recurse -Filter 'installer-hashes.sha256' -File)
    if ($Installers.Count -ne 1 -or $Manifests.Count -ne 1) {
        throw 'Expected exactly one installer and one SHA256 manifest.'
    }
    $Installer = $Installers[0]
    if ($Installer.DirectoryName -ne $Root -or $Manifests[0].DirectoryName -ne $Root) {
        throw 'Release assets must be at the artifact root.'
    }
    $Rows = @(Get-Content -LiteralPath $Manifests[0].FullName | Where-Object { $_ -and -not $_.StartsWith('#') })
    if ($Rows.Count -ne 1 -or $Rows[0] -cnotmatch '^([A-Fa-f0-9]{64})  ([^/\\\r\n]+)$') {
        throw 'Hash manifest must contain exactly one SHA256 and a plain installer filename.'
    }
    $ExpectedHash = $Matches[1]
    $ExpectedName = $Matches[2]
    if ($ExpectedName -cne $Installer.Name) { throw 'Hash manifest filename does not match the installer.' }
    $Hash = (Get-FileHash -LiteralPath $Installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Hash -ne $ExpectedHash) { throw 'Installer SHA256 does not match the manifest.' }
    $Stable = $Tag -match '^v[0-9]+\.[0-9]+\.[0-9]+(?:\+.*)?$'
    $Signature = Get-AuthenticodeSignature -LiteralPath $Installer.FullName
    if ($Signature.Status -notin @('Valid', 'NotSigned')) {
        throw "Installer has an invalid signature: $($Signature.Status)."
    }
    if ($Stable -and $Signature.Status -ne 'Valid') {
        throw 'Stable releases require a valid Authenticode signature.'
    }
    [PSCustomObject]@{
        Root = $Root
        Installer = $Installer
        Manifest = $Manifests[0]
        Sha256 = $Hash
        Stable = $Stable
        SigningStatus = if ($Signature.Status -eq 'Valid') { 'signed' } else { 'unsigned' }
    }
}
