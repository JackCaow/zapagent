param(
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDirectory,
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string]$Bundle,
    [Parameter(Mandatory = $true)]
    [string]$PublicKey,
    [Parameter(Mandatory = $true)]
    [string]$BundleSHA256,
    [Parameter(Mandatory = $true)]
    [string]$PublicKeySHA256,
    [string]$HostArchive = "",
    [string]$HostSHA256 = ""
)

$ErrorActionPreference = "Stop"
$Version = $Version.TrimStart("v")
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { throw "Invalid candidate version: $Version" }
foreach ($hash in @($BundleSHA256, $PublicKeySHA256)) {
    if ($hash -cnotmatch '^[0-9a-f]{64}$') { throw "Candidate SHA-256 values must be lowercase hexadecimal" }
}
if (-not [string]::IsNullOrWhiteSpace($HostArchive) -and $HostSHA256 -cnotmatch '^[0-9a-f]{64}$') {
    throw "HostSHA256 is required with HostArchive and must be lowercase hexadecimal"
}
if ([string]::IsNullOrWhiteSpace($HostArchive) -and -not [string]::IsNullOrWhiteSpace($HostSHA256)) {
    throw "HostArchive is required with HostSHA256"
}
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { throw "This candidate requires an amd64 Windows Host" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Native Windows acceptance requires an elevated Administrator PowerShell"
}

foreach ($path in @($EvidenceDirectory, $Bundle, $PublicKey)) {
    if (-not [IO.Path]::IsPathRooted($path)) { throw "All paths must be absolute: $path" }
}
if (-not [string]::IsNullOrWhiteSpace($HostArchive) -and -not [IO.Path]::IsPathRooted($HostArchive)) {
    throw "HostArchive path must be absolute"
}
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
$Bundle = [IO.Path]::GetFullPath($Bundle)
$PublicKey = [IO.Path]::GetFullPath($PublicKey)
if (Test-Path -LiteralPath $EvidenceDirectory) { throw "Refusing existing evidence directory: $EvidenceDirectory" }
foreach ($path in @($Bundle, $PublicKey)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing candidate file: $path" }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Candidate file is a reparse point: $path" }
}
if (-not [string]::IsNullOrWhiteSpace($HostArchive)) {
    $HostArchive = [IO.Path]::GetFullPath($HostArchive)
    if (-not (Test-Path -LiteralPath $HostArchive -PathType Leaf)) { throw "Missing Host archive: $HostArchive" }
    $hostItem = Get-Item -LiteralPath $HostArchive -Force
    if (($hostItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Host archive is a reparse point" }
}

$RepoDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$PackageStaging = Join-Path ([IO.Path]::GetTempPath()) ("zapvm-native-windows-package-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $EvidenceDirectory | Out-Null
New-Item -ItemType Directory -Path $PackageStaging | Out-Null

try {
    & (Join-Path $PSScriptRoot "preflight-self-hosted-windows.ps1") -Target windows-acl-recovery 2>&1 |
        Tee-Object -FilePath (Join-Path $EvidenceDirectory "host-preflight.log")

    $actualBundleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Bundle).Hash.ToLowerInvariant()
    $actualPublicKeyHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PublicKey).Hash.ToLowerInvariant()
    if ($actualBundleHash -ne $BundleSHA256) { throw "Bundle SHA-256 mismatch" }
    if ($actualPublicKeyHash -ne $PublicKeySHA256) { throw "Public-key SHA-256 mismatch" }

    if ([string]::IsNullOrWhiteSpace($HostArchive)) {
        $releaseDirectory = Join-Path $EvidenceDirectory "release"
        & (Join-Path $PSScriptRoot "package-host-release.ps1") -Version $Version -OutputDirectory $releaseDirectory
        $HostArchive = Join-Path $releaseDirectory "zapvm_${Version}_windows_amd64.zip"
        $HostSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $HostArchive).Hash.ToLowerInvariant()
    } else {
        $actualHostHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $HostArchive).Hash.ToLowerInvariant()
        if ($actualHostHash -ne $HostSHA256) { throw "Host archive SHA-256 mismatch" }
    }
    & (Join-Path $PSScriptRoot "verify-host-release.ps1") -Archive $HostArchive -Version $Version

    Expand-Archive -LiteralPath $HostArchive -DestinationPath $PackageStaging
    $package = Join-Path $PackageStaging "zapvm_${Version}_windows_amd64"
    foreach ($file in @("zapvm.exe", "zapvm-image.exe")) {
        if (-not (Test-Path -LiteralPath (Join-Path $package $file) -PathType Leaf)) { throw "Host package is missing $file" }
    }

    $upgrade = Join-Path $PackageStaging "zapvm-upgrade-fixture.exe"
    Push-Location $RepoDirectory
    try {
        & go build -trimpath -ldflags "-X main.version=${Version}-upgrade-fixture" -o $upgrade ./cmd/zapvm
        if ($LASTEXITCODE -ne 0) { throw "Upgrade fixture build failed" }
    } finally {
        Pop-Location
    }

    $sourceCommit = "unavailable"
    try {
        $resolvedCommit = (& git -C $RepoDirectory rev-parse HEAD 2>$null).Trim()
        if ($LASTEXITCODE -eq 0 -and $resolvedCommit -match '^[0-9a-f]{40}$') { $sourceCommit = $resolvedCommit }
    } catch {}
    [ordered]@{
        target = "windows-hcs"
        source_commit = $sourceCommit
        candidate_version = $Version
        bundle = $Bundle
        bundle_sha256 = $actualBundleHash
        public_key = $PublicKey
        public_key_sha256 = $actualPublicKeyHash
        host_archive = $HostArchive
        host_sha256 = $HostSHA256
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "candidate-identity.json") -Encoding utf8

    $complete = Join-Path $EvidenceDirectory "complete"
    $completeParameters = @{
        EvidenceDirectory = $complete
        Architecture = "amd64"
        SignedImageBundle = $Bundle
        SignedImagePublicKey = $PublicKey
        ZapVMExecutable = Join-Path $package "zapvm.exe"
        UpgradeZapVMExecutable = $upgrade
        ImageToolExecutable = Join-Path $package "zapvm-image.exe"
    }
    & (Join-Path $PSScriptRoot "acceptance-windows.ps1") @completeParameters

    $active = Get-Content -Raw -LiteralPath (Join-Path $complete "images\active.json") | ConvertFrom-Json
    $aclParameters = @{
        ImageRoot = Join-Path $complete "images"
        ImagePublicKey = $PublicKey
        StateTemplate = Join-Path (Join-Path (Join-Path $complete "images") $active.active_version) "state.vhdx"
        Workspace = Join-Path $complete "workspace"
        EvidenceDirectory = Join-Path $EvidenceDirectory "acl-recovery"
    }
    & (Join-Path $PSScriptRoot "acceptance-windows-hcs-grant-recovery.ps1") @aclParameters

    "NATIVE_CANDIDATE_ACCEPTANCE_OK target=windows-hcs evidence=$EvidenceDirectory" |
        Tee-Object -FilePath (Join-Path $EvidenceDirectory "result.txt")
}
finally {
    Remove-Item -LiteralPath $PackageStaging -Recurse -Force -ErrorAction SilentlyContinue
}
