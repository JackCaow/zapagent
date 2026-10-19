param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$Version = $Version.TrimStart("v")
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { throw "invalid version: $Version" }
$Archive = [IO.Path]::GetFullPath($Archive)
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "archive not found: $Archive" }
if (-not $Archive.EndsWith(".zip", [StringComparison]::OrdinalIgnoreCase)) { throw "expected a .zip Host archive" }

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$ArchiveBase = [IO.Path]::GetFileNameWithoutExtension($Archive)
$TemporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("zapvm-verify-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TemporaryDirectory | Out-Null

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)') { throw "archive contains an unsafe path: $name" }
        }
    }
    finally { $zip.Dispose() }

    Expand-Archive -LiteralPath $Archive -DestinationPath $TemporaryDirectory
    $PackageRoot = Join-Path $TemporaryDirectory $ArchiveBase
    foreach ($file in @("zapvm.exe", "zapvm-node.exe", "zapvm-agent-adapter.exe", "zapvm-image.exe", "zapvm-sbom.exe", "zapvm-host-install.ps1", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md")) {
        if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $file) -PathType Leaf)) { throw "package is missing $file" }
        $item = Get-Item -LiteralPath (Join-Path $PackageRoot $file) -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "package entry is a reparse point: $file" }
    }

    $zapVersion = (& (Join-Path $PackageRoot "zapvm.exe") version).Trim()
    if ($LASTEXITCODE -ne 0 -or $zapVersion -ne $Version) { throw "zapvm version mismatch: $zapVersion" }
    $nodeVersion = (& (Join-Path $PackageRoot "zapvm-node.exe") --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne $Version) { throw "zapvm-node version mismatch: $nodeVersion" }
    $adapterVersion = (& (Join-Path $PackageRoot "zapvm-agent-adapter.exe") version).Trim()
    if ($LASTEXITCODE -ne 0 -or $adapterVersion -ne $Version) { throw "zapvm-agent-adapter version mismatch: $adapterVersion" }

    function Assert-CliError([string]$Executable, [string[]]$Arguments, [int]$ExpectedExit, [string]$ExpectedMarker) {
        $output = (& $Executable @Arguments 2>&1 | Out-String)
        $status = $LASTEXITCODE
        if ($status -ne $ExpectedExit) { throw "$Executable error exit=$status, want $ExpectedExit" }
        if (-not $output.Contains($ExpectedMarker)) { throw "$Executable is missing $ExpectedMarker" }
    }
    Assert-CliError (Join-Path $PackageRoot "zapvm.exe") @("not-a-command") 64 "ZAPVM_ERROR[invalid_request]"
    Assert-CliError (Join-Path $PackageRoot "zapvm-image.exe") @() 64 "ZAPVM_ERROR[invalid_request]"
    Assert-CliError (Join-Path $PackageRoot "zapvm-node.exe") @() 78 "ZAPVM_ERROR[invalid_configuration]"
    Assert-CliError (Join-Path $PackageRoot "zapvm-sbom.exe") @() 78 "ZAPVM_ERROR[invalid_configuration]"
    # The expected-error probes above intentionally leave PowerShell's native
    # process status non-zero. Clear it after all assertions pass so callers do
    # not mistake a successful package verification for a failed script.
    $global:LASTEXITCODE = 0

    $documents = @("installation.md", "host-install-macos.md", "host-install-linux.md", "host-install-windows.md", "node-operations.md", "agent-integration.md", "diagnostics.md", "error-taxonomy.md", "layered-image-delivery.md")
    foreach ($file in $documents) {
        $source = (Get-FileHash -Algorithm SHA256 (Join-Path $RepositoryRoot "docs\$file")).Hash
        $packaged = (Get-FileHash -Algorithm SHA256 (Join-Path $PackageRoot "docs\$file")).Hash
        if ($source -ne $packaged) { throw "packaged docs/$file differs from source" }
    }
    foreach ($file in @("daemon.json", "cloud-node.json", "cloud-node-managed.json")) {
        $source = (Get-FileHash -Algorithm SHA256 (Join-Path $RepositoryRoot "packaging\examples\$file")).Hash
        $packaged = (Get-FileHash -Algorithm SHA256 (Join-Path $PackageRoot "examples\$file")).Hash
        if ($source -ne $packaged) { throw "packaged examples/$file differs from source" }
    }
    $installerSource = (Get-FileHash -Algorithm SHA256 (Join-Path $RepositoryRoot "scripts\zapvm-host-windows.ps1")).Hash
    $installerPackaged = (Get-FileHash -Algorithm SHA256 (Join-Path $PackageRoot "zapvm-host-install.ps1")).Hash
    if ($installerSource -ne $installerPackaged) { throw "wrong Windows Host installer" }

    Write-Output "HOST_RELEASE_OK archive=$([IO.Path]::GetFileName($Archive)) version=$Version"
}
finally {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
