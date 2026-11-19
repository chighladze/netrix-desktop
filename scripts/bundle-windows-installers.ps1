[CmdletBinding()]
param([hashtable] $SignCommand)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/windows-release.ps1')
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Config = Get-Content -Raw -LiteralPath (Join-Path $Root 'src-tauri/tauri.conf.json') | ConvertFrom-Json
$Variants = @(Get-WindowsInstallerVariants ('v' + $Config.version))
if ($Config.bundle.windows.webviewInstallMode.type -cne $Variants[0].Mode) {
    throw 'The default Tauri build must produce the Lightweight installer.'
}
$Release = Join-Path $Root 'src-tauri/target/release'
$Output = Join-Path $Release "bundle/windows-installers/$($Config.version)"
$RawInstaller = Join-Path $Release "bundle/nsis/Netrix_$($Config.version)_x64-setup.exe"
$Recipe = Join-Path $Release 'nsis/x64/installer.nsi'
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Lock = [IO.File]::Open("$Output.lock", 'OpenOrCreate', 'Write', 'None')
$Manifest = Join-Path $Output 'installer-hashes.sha256'
$Overlay = Join-Path $Output 'bundle-config.json'
Push-Location -LiteralPath $Root
try {
    if (Test-Path -LiteralPath $Manifest) { Remove-Item -LiteralPath $Manifest }
    # Tauri writes both modes to the same filename. Capture each immediately and leave the default in bundle/nsis.
    foreach ($Variant in @($Variants[1], $Variants[0])) {
        $Windows = @{ webviewInstallMode = @{ type = $Variant.Mode } }
        if ($SignCommand) { $Windows.signCommand = $SignCommand }
        @{ bundle = @{ windows = $Windows } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Overlay -Encoding utf8
        if (Test-Path -LiteralPath $RawInstaller) { Remove-Item -LiteralPath $RawInstaller }
        & node 'node_modules/@tauri-apps/cli/tauri.js' bundle --ci --bundles nsis --config $Overlay
        if ($LASTEXITCODE -ne 0) { throw "Tauri could not bundle $($Variant.Key) (exit $LASTEXITCODE)." }
        if (-not (Select-String -LiteralPath $Recipe -Quiet -SimpleMatch -Pattern ('!define INSTALLWEBVIEW2MODE "' + $Variant.Mode + '"'))) {
            throw "The generated NSIS recipe does not use $($Variant.Mode)."
        }
        Copy-Item -LiteralPath $RawInstaller -Destination (Join-Path $Output $Variant.FileName) -Force
    }
    $Rows = foreach ($Variant in $Variants) {
        $File = Get-Item -LiteralPath (Join-Path $Output $Variant.FileName)
        $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant()
        Write-Host "$($Variant.Key): $($File.Name), $($File.Length) bytes"
        "$Hash  $($File.Name)"
    }
    $Rows | Set-Content -LiteralPath $Manifest -Encoding ascii
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $Overlay) { Remove-Item -LiteralPath $Overlay }
    $Lock.Dispose()
}
