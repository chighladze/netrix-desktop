$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/windows-release.ps1')
$PublishScript = Join-Path $PSScriptRoot '../publish-windows-release.ps1'
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('netrix-release-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestRoot | Out-Null
$OriginalToken = $env:GH_TOKEN
$global:NetrixReleaseTestSignatureStatus = 'NotSigned'
$global:NetrixReleaseTestMode = 'success'
$global:NetrixReleaseTestCalls = @()

function Assert($Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}
function Expect-Failure([scriptblock] $Action, [string] $Pattern) {
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -match $Pattern) { return }
        throw
    }
    throw "Expected failure matching: $Pattern"
}
function Get-AuthenticodeSignature {
    param([string] $LiteralPath)
    [PSCustomObject]@{ Status = $global:NetrixReleaseTestSignatureStatus }
}
function gh {
    $global:NetrixReleaseTestCalls += ,@($args)
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'api') {
        return (@{ private = ($global:NetrixReleaseTestMode -eq 'private'); full_name = 'example/netrix-releases'; default_branch = 'main' } | ConvertTo-Json)
    }
    if ($args[1] -eq 'list') {
        if ($global:NetrixReleaseTestMode -eq 'network-error') { $global:LASTEXITCODE = 1; return '' }
        if ($global:NetrixReleaseTestMode -eq 'existing') { return '[{"tagName":"v0.3.0-beta.1","isDraft":false}]' }
        return '[]'
    }
    if ($args[1] -eq 'create') {
        Assert ($args -contains '--draft') 'Publication must start as a draft.'
        Assert ($args -contains '--prerelease') 'Unsigned builds must be prereleases.'
        Assert ($args -contains '--notes-file') 'Notes must be passed as a file.'
        Assert (-not ($args -contains '--clobber')) 'Existing assets must never be overwritten.'
        foreach ($Name in @('Netrix setup.exe', 'installer-hashes.sha256', 'release.json')) {
            Assert ($args -contains (Join-Path $TestRoot $Name)) "Missing attachment: $Name"
        }
        return 'Draft created'
    }
    if ($args[1] -eq 'view') {
        $Assets = @('Netrix setup.exe', 'installer-hashes.sha256', 'release.json') | ForEach-Object {
            $File = Get-Item -LiteralPath (Join-Path $TestRoot $_)
            @{ name = $File.Name; size = $File.Length }
        }
        if ($global:NetrixReleaseTestMode -eq 'incomplete') { $Assets = @($Assets[0]) }
        return (@{ isDraft = $true; isPrerelease = $true; tagName = 'v0.3.0-beta.1'; assets = @($Assets); url = 'https://example.invalid/draft' } | ConvertTo-Json -Depth 5)
    }
    throw "Unexpected GitHub CLI operation: $args"
}

try {
    foreach ($Tag in @('v0.3.0-beta.1', 'v1.0.0', 'v1.0.0+build-with-dash')) { Assert-ReleaseTag $Tag }
    foreach ($Tag in @('v', 'v01.2.3', 'v1.2.3-01', '1.2.3', 'v1.2.3;write-host')) {
        Expect-Failure { Assert-ReleaseTag $Tag } 'SemVer'
    }
    $Installer = Join-Path $TestRoot 'Netrix setup.exe'
    Set-Content -LiteralPath $Installer -Value 'A test fixture, never executed.' -Encoding ASCII
    $Hash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $Manifest = Join-Path $TestRoot 'installer-hashes.sha256'
    $ValidRow = "$Hash  Netrix setup.exe"
    Set-Content -LiteralPath $Manifest -Value $ValidRow -Encoding ASCII
    $Package = Get-VerifiedReleasePackage 'v0.3.0-beta.1' $TestRoot
    Assert ($Package.SigningStatus -eq 'unsigned') 'Expected unsigned prerelease.'
    Expect-Failure { Get-VerifiedReleasePackage 'v0.3.0' $TestRoot } 'Stable releases require'
    Expect-Failure { Get-VerifiedReleasePackage 'v0.3.0+build-with-dash' $TestRoot } 'Stable releases require'
    Set-Content -LiteralPath $Manifest -Value "$Hash  other.exe" -Encoding ASCII
    Expect-Failure { Get-VerifiedReleasePackage 'v0.3.0-beta.1' $TestRoot } 'filename'
    Set-Content -LiteralPath $Manifest -Value "$Hash  ../Netrix setup.exe" -Encoding ASCII
    Expect-Failure { Get-VerifiedReleasePackage 'v0.3.0-beta.1' $TestRoot } 'plain installer filename'
    Set-Content -LiteralPath $Manifest -Value (('0' * 64) + '  Netrix setup.exe') -Encoding ASCII
    Expect-Failure { Get-VerifiedReleasePackage 'v0.3.0-beta.1' $TestRoot } 'SHA256 does not match'
    Set-Content -LiteralPath $Manifest -Value $ValidRow -Encoding ASCII
    $global:NetrixReleaseTestSignatureStatus = 'HashMismatch'
    Expect-Failure { Get-VerifiedReleasePackage 'v0.3.0-beta.1' $TestRoot } 'invalid signature'
    $global:NetrixReleaseTestSignatureStatus = 'NotSigned'
    $MetadataPath = Join-Path $TestRoot 'release.json'
    $Metadata = @{ schemaVersion = 1; tag = 'v0.3.0-beta.1'; version = '0.3.0-beta.1';
        platform = 'windows-x86_64'; fileName = 'Netrix setup.exe'; size = (Get-Item $Installer).Length;
        sha256 = $Hash; signingStatus = 'unsigned'; sourceCommit = ('a' * 40) }
    $Metadata | ConvertTo-Json | Set-Content -LiteralPath $MetadataPath -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $TestRoot 'release-notes.md') -Value 'Fixture notes' -Encoding UTF8
    $env:GH_TOKEN = 'test-fixture-not-a-credential'
    $InvokeDraft = { & $PublishScript -Tag 'v0.3.0-beta.1' -Repository 'example/netrix-releases' -ArtifactDirectory $TestRoot }
    foreach ($Case in @(@('private', 'public distribution'), @('existing', 'already exists'), @('network-error', 'inspect existing'))) {
        $global:NetrixReleaseTestMode = $Case[0]; $global:NetrixReleaseTestCalls = @()
        Expect-Failure $InvokeDraft $Case[1]
        Assert (@($global:NetrixReleaseTestCalls | Where-Object { $_[1] -eq 'create' }).Count -eq 0) 'A rejected draft must not create a release.'
    }
    $global:NetrixReleaseTestMode = 'success'; $global:NetrixReleaseTestCalls = @()
    & $InvokeDraft | Out-Null
    Assert (@($global:NetrixReleaseTestCalls | Where-Object { $_[1] -eq 'create' }).Count -eq 1) 'Expected one complete draft creation.'
    $global:NetrixReleaseTestMode = 'incomplete'
    Expect-Failure $InvokeDraft 'incomplete or unexpected'
    $Metadata.sha256 = '0' * 64
    $Metadata | ConvertTo-Json | Set-Content -LiteralPath $MetadataPath -Encoding UTF8
    Expect-Failure $InvokeDraft 'metadata does not match'
    Write-Host 'All release safety scenarios passed'
} finally {
    $env:GH_TOKEN = $OriginalToken
    $ResolvedTestRoot = [IO.Path]::GetFullPath($TestRoot)
    $TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $ResolvedTestRoot.StartsWith($TempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $ResolvedTestRoot -Leaf) -notmatch '^netrix-release-test-[a-f0-9]{32}$') {
        throw 'Refusing cleanup outside the disposable release fixture.'
    }
    Remove-Item -LiteralPath $ResolvedTestRoot -Recurse -Force
}
