[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('create','reopen')][string] $Phase,
    [Parameter(Mandatory)][string] $Archive,
    [Parameter(Mandatory)][string] $EvidenceDirectory,
    [Parameter(Mandatory)][ValidatePattern('^[A-Z]$')][string] $DriveLetter
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$file = Get-Item -LiteralPath $Archive
if ($file.Name -cnotmatch '^Netrix_(.+)_x64-portable\.zip$') { throw 'Expected the versioned Portable release ZIP.' }
$version = $Matches[1]
$archiveHash = (Get-FileHash -LiteralPath $file.FullName).Hash
$entries = [IO.Compression.ZipFile]::OpenRead($file.FullName)
try {
    $expected = @('Data/', 'LICENSE', 'Netrix.exe', 'netrix_backend.exe', 'Netrix.portable')
    if ($entries.Entries.Count -ne $expected.Count -or
        @(Compare-Object $expected @($entries.Entries.FullName) -CaseSensitive).Count -ne 0 -or
        $entries.GetEntry('Data/').Length -ne 0 -or $entries.GetEntry('Netrix.portable').Length -ne 0) {
        throw 'Unexpected contents in the public Portable archive.'
    }
} finally { $entries.Dispose() }

function Get-IdentityHash([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Missing Windows identity for the transfer check.' }
    $stream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($Value))
    try { (Get-FileHash -Algorithm SHA256 -InputStream $stream).Hash } finally { $stream.Dispose() }
}
$machineGuid = [guid](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
if ($machineGuid -eq [guid]::Empty) { throw 'Windows installation identity is empty.' }
$machine = Get-IdentityHash ($machineGuid.ToString('D'))
$account = Get-IdentityHash ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$system = (Get-CimInstance Win32_OperatingSystem).Caption
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$evidence = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$checkpoint = Join-Path $evidence 'transfer.json'
$dataArchive = Join-Path $evidence 'synthetic-data.zip'
$drive = "${DriveLetter}:"
if ([IO.Directory]::Exists("$drive\") -or (Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue)) {
    throw "$drive is already in use; leave existing drives untouched."
}
if ($Phase -eq 'reopen') {
    $previous = Get-Content -LiteralPath $checkpoint -Raw | ConvertFrom-Json
    if ($previous.machine -eq $machine -or $previous.account -eq $account -or $previous.drive -eq $drive) {
        throw 'Reopen requires a different Windows machine, user SID and drive letter.'
    }
    if ($previous.archiveSha256 -ne $archiveHash -or $previous.dataSha256 -ne (Get-FileHash -LiteralPath $dataArchive).Hash) {
        throw 'Release or transferred workspace checksum differs from the first PC.'
    }
    $fixture = $previous.fixture
} else {
    if (Test-Path -LiteralPath $checkpoint) { throw 'Create requires a fresh evidence directory.' }
    $fixture = [guid]::NewGuid().ToString('N')
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("netrix-portable-qa-" + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($scratch)
& subst.exe $drive $scratch
if ($LASTEXITCODE -ne 0) { throw "Could not mount the disposable $drive drive." }
try {
    $folder = "$drive\$Phase workspace\Netrix"
    [IO.Compression.ZipFile]::ExtractToDirectory($file.FullName, $folder)
    $data = Join-Path $folder 'Data'
    $identityFiles = @('database.db', '.database-key', '.vault_salt', '.secret_key')
    if ($Phase -eq 'reopen') {
        [IO.Compression.ZipFile]::ExtractToDirectory($dataArchive, $data)
        foreach ($name in $identityFiles) {
            if ((Get-FileHash -LiteralPath (Join-Path $data $name)).Hash -ne $previous.files.$name) {
                throw "Transferred $name differs before the first launch on this PC."
            }
        }
    }
    & node (Join-Path $PSScriptRoot 'portable-workspace-smoke.mjs') $Phase $folder $version $fixture
    if ($LASTEXITCODE -ne 0) { throw "Portable $Phase desktop check failed." }
    if (!(Test-Path -LiteralPath (Join-Path $data 'WebView2') -PathType Container)) { throw 'Missing portable preferences directory.' }
    $record = [ordered]@{ phase = $Phase; version = $version; archiveSha256 = $archiveHash; fixture = $fixture
        machine = $machine; account = $account; system = $system; drive = $drive; folder = $folder
        host = 'portable.example.invalid:2227'; fontSize = 19; fontFamily = 'Cascadia Code'; vaultItemVerified = $true
        validPasswordAccepted = $true; invalidVaultPasswordRejected = $true }
    if ($Phase -eq 'create') {
        $record.files = @{}
        foreach ($name in $identityFiles) { $record.files[$name] = (Get-FileHash -LiteralPath (Join-Path $data $name)).Hash }
        # WebView2 helper processes can briefly hold files after the shell exits.
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            try { [IO.Compression.ZipFile]::CreateFromDirectory($data, $dataArchive); break }
            catch [IO.IOException] {
                if ([DateTime]::UtcNow -ge $deadline) { throw }
                if ([IO.File]::Exists($dataArchive)) { [IO.File]::Delete($dataArchive) }
                Start-Sleep -Milliseconds 500
            }
        } while ($true)
        $record.dataSha256 = (Get-FileHash -LiteralPath $dataArchive).Hash
        $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $checkpoint -Encoding UTF8
    } else {
        $record.fromDrive = $previous.drive
        $record.distinctMachineAndAccount = $true
        $record.transferredFilesMatched = $true
        $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $evidence 'reopen.json') -Encoding UTF8
    }
    Write-Host "PASS $Phase on $system at $folder (release SHA-256 $archiveHash)"
} finally {
    & subst.exe $drive /d
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($scratch)) -ne $tempRoot -or
        [IO.Path]::GetFileName($scratch) -notmatch '^netrix-portable-qa-[a-f0-9]{32}$') {
        throw 'Unexpected disposable scratch path.'
    }
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
