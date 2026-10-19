param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$Version = $Version.TrimStart("v")
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { throw "invalid version: $Version" }

$Repository = if ($env:ZAPVM_GITHUB_REPOSITORY) { $env:ZAPVM_GITHUB_REPOSITORY } else { "JackCaow/zapVM" }
$InstallDirectory = if ($env:ZAPVM_INSTALL_DIRECTORY) { $env:ZAPVM_INSTALL_DIRECTORY } else { Join-Path $env:LOCALAPPDATA "zapVM\bin" }
$ShareDirectory = if ($env:ZAPVM_SHARE_DIRECTORY) { $env:ZAPVM_SHARE_DIRECTORY } else { Join-Path (Split-Path -Parent $InstallDirectory) "share" }
$HostArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ($HostArch) {
    "x64" { $HostArch = "amd64" }
    "arm64" { $HostArch = "arm64" }
    default { throw "unsupported host architecture: $HostArch" }
}

$ArchiveBase = "zapvm_${Version}_windows_${HostArch}"
$Archive = "$ArchiveBase.zip"
$BaseURL = if ($env:ZAPVM_RELEASE_BASE_URL) { $env:ZAPVM_RELEASE_BASE_URL.TrimEnd('/') } else { "https://github.com/$Repository/releases/download/v$Version" }
if (-not $BaseURL.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) { throw "ZAPVM_RELEASE_BASE_URL must use https" }
$TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("zapvm-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TemporaryDirectory | Out-Null

try {
    Invoke-WebRequest -Uri "$BaseURL/$Archive" -OutFile (Join-Path $TemporaryDirectory $Archive) -UseBasicParsing
    Invoke-WebRequest -Uri "$BaseURL/SHA256SUMS" -OutFile (Join-Path $TemporaryDirectory "SHA256SUMS") -UseBasicParsing

    $ChecksumLine = Get-Content (Join-Path $TemporaryDirectory "SHA256SUMS") | Where-Object { $_ -match "\s(\./)?$([regex]::Escape($Archive))$" } | Select-Object -First 1
    if (-not $ChecksumLine) { throw "release checksum does not contain $Archive" }
    $Expected = ($ChecksumLine -split '\s+')[0].ToLowerInvariant()
    $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $TemporaryDirectory $Archive)).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw "checksum mismatch for $Archive" }

    $ArchivePath = Join-Path $TemporaryDirectory $Archive
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName.Replace('\', '/')
            if ($Name.StartsWith('/') -or $Name -match '(^|/)\.\.(/|$)') { throw "release archive contains an unsafe path: $Name" }
        }
    }
    finally { $Zip.Dispose() }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TemporaryDirectory
    $PackageRoot = Join-Path $TemporaryDirectory $ArchiveBase
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    foreach ($Binary in @("zapvm.exe", "zapvm-node.exe", "zapvm-agent-adapter.exe", "zapvm-image.exe", "zapvm-sbom.exe", "zapvm-host-install.ps1")) {
        $Source = Join-Path $PackageRoot $Binary
        if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "package is missing $Binary" }
        $Item = Get-Item -LiteralPath $Source -Force
        if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "package entry is a reparse point: $Binary" }
        Copy-Item -LiteralPath $Source -Destination (Join-Path $InstallDirectory $Binary) -Force
    }
    foreach ($Example in @("daemon.json", "cloud-node.json", "cloud-node-managed.json")) {
        $Source = Join-Path $PackageRoot "examples\$Example"
        if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "package is missing examples/$Example" }
        $Item = Get-Item -LiteralPath $Source -Force
        if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "package entry is a reparse point: examples/$Example" }
    }
    New-Item -ItemType Directory -Path (Join-Path $ShareDirectory "docs"), (Join-Path $ShareDirectory "examples") -Force | Out-Null
    foreach ($Document in @("installation.md", "host-install-macos.md", "host-install-linux.md", "host-install-windows.md", "node-operations.md", "agent-integration.md")) {
        Copy-Item -LiteralPath (Join-Path $PackageRoot "docs\$Document") -Destination (Join-Path $ShareDirectory "docs\$Document") -Force
    }
    foreach ($Example in @("daemon.json", "cloud-node.json", "cloud-node-managed.json")) {
        Copy-Item -LiteralPath (Join-Path $PackageRoot "examples\$Example") -Destination (Join-Path $ShareDirectory "examples\$Example") -Force
    }

    Write-Output "installed zapVM Host tools in $InstallDirectory"
    Write-Output "run: $InstallDirectory\zapvm.exe doctor"
    Write-Output "remote Host installer: $InstallDirectory\zapvm-host-install.ps1"
    Write-Output "offline guides and configuration examples: $ShareDirectory"
    Write-Output "a separately signed guest image is required; see $ShareDirectory\docs\installation.md"
}
finally {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
