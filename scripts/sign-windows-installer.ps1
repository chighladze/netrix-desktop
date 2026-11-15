[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Tag,
    [string] $ArtifactDirectory = "release-artifacts",
    [string] $TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'lib/windows-release.ps1')
Assert-ReleaseTag $Tag

$Installers = @(Get-ChildItem -Path $ArtifactDirectory -Recurse -Filter "*.exe" -File)
if ($Installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer to sign, found $($Installers.Count)."
}
$Installer = $Installers[0]
$IsStable = $Tag -match '^v\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$'
$CertificateBase64 = [string] $env:WINDOWS_CERTIFICATE
$CertificatePassword = [string] $env:WINDOWS_CERTIFICATE_PASSWORD
$HashManifest = Join-Path (Resolve-Path $ArtifactDirectory).Path "installer-hashes.sha256"

function Write-InstallerHash {
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer.FullName).Hash
    @(
        "# Netrix installer SHA256 hashes",
        "# Generated after release signing step: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))",
        "",
        "$Hash  $($Installer.Name)"
    ) | Set-Content -LiteralPath $HashManifest -Encoding ASCII
}

if ([string]::IsNullOrWhiteSpace($CertificateBase64) -or
    [string]::IsNullOrWhiteSpace($CertificatePassword)) {
    if ($IsStable) {
        throw "Stable tag $Tag requires WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD in the release repository secrets."
    }
    Write-Warning "No Authenticode certificate configured; preparing $Tag as an explicitly unsigned prerelease."
    Write-InstallerHash
    exit 0
}

$PfxPath = Join-Path ([System.IO.Path]::GetTempPath()) "netrix-signing-$([Guid]::NewGuid().ToString('N')).pfx"
$ExistingThumbprints = @(
    Get-ChildItem Cert:\CurrentUser\My | ForEach-Object { $_.Thumbprint }
)
$ImportedThumbprints = @()

try {
    $NormalizedBase64 = $CertificateBase64 `
        -replace '-----BEGIN [^-]+-----', '' `
        -replace '-----END [^-]+-----', '' `
        -replace '\s', ''
    try {
        [System.IO.File]::WriteAllBytes(
            $PfxPath,
            [Convert]::FromBase64String($NormalizedBase64)
        )
    } catch {
        throw "WINDOWS_CERTIFICATE is not a valid base64-encoded PFX: $($_.Exception.Message)"
    }

    $SecurePassword = ConvertTo-SecureString $CertificatePassword -AsPlainText -Force
    $Imported = @(
        Import-PfxCertificate `
            -FilePath $PfxPath `
            -CertStoreLocation Cert:\CurrentUser\My `
            -Password $SecurePassword
    )
    $ImportedThumbprints = @($Imported | ForEach-Object { $_.Thumbprint })
    $CodeSigningOid = "1.3.6.1.5.5.7.3.3"
    $SigningCertificate = @(
        $Imported | Where-Object {
            $_.HasPrivateKey -and
            @($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq $CodeSigningOid }).Count -gt 0
        }
    ) | Select-Object -First 1
    if (-not $SigningCertificate) {
        throw "The PFX does not contain a private key certificate valid for code signing."
    }

    $SignTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if (-not $SignTool) {
        $KitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
        $SignTool = Get-ChildItem -Path $KitsRoot -Recurse -Filter signtool.exe -File |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
    }
    if (-not $SignTool) {
        throw "signtool.exe was not found on the Windows release runner."
    }
    $SignToolPath = if ($SignTool -is [System.Management.Automation.CommandInfo]) {
        $SignTool.Source
    } else {
        $SignTool.FullName
    }

    & $SignToolPath sign `
        /sha1 $SigningCertificate.Thumbprint `
        /s My `
        /fd SHA256 `
        /tr $TimestampUrl `
        /td SHA256 `
        $Installer.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed to sign the NSIS installer (exit code $LASTEXITCODE)."
    }

    & $SignToolPath verify /pa /all /v $Installer.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "signtool could not verify the signed installer (exit code $LASTEXITCODE)."
    }
    $Signature = Get-AuthenticodeSignature -LiteralPath $Installer.FullName
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode verification returned $($Signature.Status): $($Signature.StatusMessage)"
    }

    Write-InstallerHash
    Write-Host "Signed and verified $($Installer.Name); regenerated installer-hashes.sha256."
} finally {
    Remove-Item -LiteralPath $PfxPath -Force -ErrorAction SilentlyContinue
    foreach ($Thumbprint in $ImportedThumbprints) {
        if ($ExistingThumbprints -notcontains $Thumbprint) {
            Remove-Item -LiteralPath "Cert:\CurrentUser\My\$Thumbprint" -Force -ErrorAction SilentlyContinue
        }
    }
}
