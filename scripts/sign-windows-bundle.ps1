[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Tag,
    [Parameter(Mandatory = $true)]
    [string[]] $InstallerPath,
    [string] $TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'lib/windows-release.ps1')
Assert-ReleaseTag $Tag

$Installers = @(Get-Item -LiteralPath $InstallerPath)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$IsStable = $Tag -match '^v\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$'
$CertificateBase64 = [string] $env:WINDOWS_CERTIFICATE
$CertificatePassword = [string] $env:WINDOWS_CERTIFICATE_PASSWORD
$HasCertificate = ![string]::IsNullOrWhiteSpace($CertificateBase64)
$HasPassword = ![string]::IsNullOrWhiteSpace($CertificatePassword)
if (!$HasCertificate -or !$HasPassword) {
    if ($IsStable -or ($HasCertificate -xor $HasPassword)) {
        throw "Signing $Tag requires both WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD."
    }
    foreach ($Installer in $Installers) {
        if ((Get-AuthenticodeSignature -LiteralPath $Installer.FullName).Status -ne 'NotSigned') {
            throw 'Expected unsigned installers from the release gate.'
        }
    }
    Write-Warning "No Authenticode certificate configured; preparing $Tag as an explicitly unsigned prerelease."
    return
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
        throw "WINDOWS_CERTIFICATE is not a valid base64-encoded PFX."
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

    $SignArguments = @('sign', '/sha1', $SigningCertificate.Thumbprint, '/s', 'My',
        '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256')
    $StagedSidecar = Join-Path $RepoRoot 'src-tauri/binaries/netrix_backend-x86_64-pc-windows-msvc.exe'
    $OutputSidecar = Join-Path $RepoRoot 'src-tauri/target/release/netrix_backend.exe'
    $MainExecutable = Join-Path $RepoRoot 'src-tauri/target/release/netrix.exe'

    # NSIS reads externalBin from its staged path. Sign it before NSIS embeds
    # it, regardless of the Tauri CLI's external-binary signing behavior.
    & $SignToolPath @SignArguments $StagedSidecar
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed to sign the staged backend (exit code $LASTEXITCODE)."
    }

    # The bundler signs the main EXE after patching it and before embedding
    # it (including the probe), signs the uninstaller, then signs Setup.
    $SignCommand = @{
        cmd = $SignToolPath
        args = @($SignArguments + '%1')
    }
    $env:WINDOWS_CERTIFICATE = $null
    $env:WINDOWS_CERTIFICATE_PASSWORD = $null
    & (Join-Path $PSScriptRoot 'bundle-windows-installers.ps1') -SignCommand $SignCommand

    foreach ($Exe in (@($MainExecutable, $StagedSidecar) + $Installers.FullName)) {
        & $SignToolPath verify /pa /all /v $Exe
        if ($LASTEXITCODE -ne 0) { throw "signtool could not verify $Exe." }
        $Signature = Get-AuthenticodeSignature -LiteralPath $Exe
        if ($Signature.Status -ne 'Valid' -or
            $Signature.SignerCertificate.Thumbprint -ne $SigningCertificate.Thumbprint -or
            !$Signature.TimeStamperCertificate) {
            throw "Expected a valid timestamped signature from the release signer on $Exe."
        }
    }
    Copy-Item -LiteralPath $StagedSidecar -Destination $OutputSidecar -Force
    Write-Host 'Verified signatures for the shell, sidecar and both NSIS installers.'
} finally {
    $env:WINDOWS_CERTIFICATE = $CertificateBase64
    $env:WINDOWS_CERTIFICATE_PASSWORD = $CertificatePassword
    Remove-Item -LiteralPath $PfxPath -Force -ErrorAction SilentlyContinue
    foreach ($Thumbprint in $ImportedThumbprints) {
        if ($ExistingThumbprints -notcontains $Thumbprint) {
            Remove-Item -LiteralPath "Cert:\CurrentUser\My\$Thumbprint" -Force -ErrorAction SilentlyContinue
        }
    }
}
