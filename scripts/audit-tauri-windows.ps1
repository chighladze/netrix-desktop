[CmdletBinding()]
param(
    [string] $Lockfile = "src-tauri/Cargo.lock",
    [string] $Manifest = "src-tauri/Cargo.toml",
    [string] $Target = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$ReportJson = cargo audit --file $Lockfile --json
$AuditExitCode = $LASTEXITCODE
if ([string]::IsNullOrWhiteSpace(($ReportJson -join ""))) {
    throw "cargo audit did not produce a JSON report (exit code $AuditExitCode)."
}

try {
    $Report = $ReportJson | ConvertFrom-Json
} catch {
    throw "Failed to parse cargo audit JSON output: $($_.Exception.Message)"
}

$Active = @()
foreach ($Vulnerability in @($Report.vulnerabilities.list)) {
    $PackageId = "$($Vulnerability.package.name)@$($Vulnerability.package.version)"
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $Tree = @(
        cargo tree --manifest-path $Manifest --target $Target --invert $PackageId 2>$null |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    $TreeExitCode = $LASTEXITCODE
    $ErrorActionPreference = $PreviousErrorActionPreference
    if ($TreeExitCode -ne 0) {
        throw "cargo tree failed while checking $PackageId for target $Target."
    }
    if ($Tree.Count -gt 0) {
        $Active += $Vulnerability
    } else {
        Write-Host "Not active for ${Target}: $($Vulnerability.advisory.id) via $PackageId"
    }
}

if ($Active.Count -gt 0) {
    $Details = ($Active | ForEach-Object {
        "$($_.advisory.id) ($($_.package.name) $($_.package.version))"
    }) -join ", "
    throw "Active RustSec vulnerabilities found for ${Target}: $Details"
}

if ($AuditExitCode -ne 0 -and [int] $Report.vulnerabilities.count -eq 0) {
    throw "cargo audit failed with exit code $AuditExitCode without a vulnerability report."
}

Write-Host "Tauri Windows dependency audit passed with no advisory ignores."
Write-Host "Cross-target lockfile vulnerabilities: $($Report.vulnerabilities.count); active on ${Target}: 0."
$WarningCount = ($Report.warnings.PSObject.Properties | ForEach-Object {
    @($_.Value).Count
} | Measure-Object -Sum).Sum
Write-Host "Allowed informational warnings reported by cargo-audit: $WarningCount."
