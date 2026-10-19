param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Version = $Version.TrimStart("v")
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
    throw "invalid release version: $Version"
}

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepositoryRoot
$HostOS = (& go env GOOS).Trim()
$HostArch = (& go env GOARCH).Trim()
if ($HostOS -ne "windows") { throw "package-host-release.ps1 supports Windows" }
if ($HostArch -notin @("amd64", "arm64")) { throw "unsupported host architecture: $HostArch" }

$ArchiveBase = "zapvm_${Version}_${HostOS}_${HostArch}"
$StagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("zapvm-release-" + [guid]::NewGuid())
$PackageRoot = Join-Path $StagingRoot $ArchiveBase
New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackageRoot "docs") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackageRoot "examples") -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$temporaryArchive = $null
$stream = $null
$zip = $null

try {
    & go build -trimpath -ldflags "-X main.version=$Version" -o (Join-Path $PackageRoot "zapvm.exe") ./cmd/zapvm
    if ($LASTEXITCODE -ne 0) { throw "zapvm build failed" }
    & go build -trimpath -ldflags "-X main.version=$Version" -o (Join-Path $PackageRoot "zapvm-node.exe") ./cmd/zapvm-node
    if ($LASTEXITCODE -ne 0) { throw "zapvm-node build failed" }
    & go build -trimpath -ldflags "-X main.version=$Version" -o (Join-Path $PackageRoot "zapvm-agent-adapter.exe") ./cmd/zapvm-agent-adapter
    if ($LASTEXITCODE -ne 0) { throw "zapvm-agent-adapter build failed" }
    & go build -trimpath -o (Join-Path $PackageRoot "zapvm-image.exe") ./cmd/zapvm-image
    if ($LASTEXITCODE -ne 0) { throw "zapvm-image build failed" }
    & go build -trimpath -o (Join-Path $PackageRoot "zapvm-sbom.exe") ./cmd/zapvm-sbom
    if ($LASTEXITCODE -ne 0) { throw "zapvm-sbom build failed" }

    Copy-Item LICENSE, NOTICE, THIRD_PARTY_NOTICES.md, README.md -Destination $PackageRoot
    Copy-Item scripts/zapvm-host-windows.ps1 -Destination (Join-Path $PackageRoot "zapvm-host-install.ps1")
    Copy-Item docs/installation.md, docs/host-install-macos.md, docs/host-install-linux.md, docs/host-install-windows.md, docs/node-operations.md, docs/agent-integration.md, docs/diagnostics.md, docs/error-taxonomy.md, docs/layered-image-delivery.md -Destination (Join-Path $PackageRoot "docs")
    Copy-Item packaging/examples/daemon.json, packaging/examples/cloud-node.json, packaging/examples/cloud-node-managed.json -Destination (Join-Path $PackageRoot "examples")
    $Archive = Join-Path $OutputDirectory "$ArchiveBase.zip"
    if (Test-Path -LiteralPath $Archive) { throw "refusing existing Host archive: $Archive" }

    $sourceDateEpoch = $env:SOURCE_DATE_EPOCH
    if ([string]::IsNullOrWhiteSpace($sourceDateEpoch)) {
        $sourceDateEpoch = (& git log -1 --format=%ct HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw "unable to resolve source commit timestamp" }
    }
    [long]$epochSeconds = 0
    if (-not [long]::TryParse($sourceDateEpoch, [ref]$epochSeconds) -or $epochSeconds -lt 315532800 -or $epochSeconds -gt 4354819199) {
        throw "SOURCE_DATE_EPOCH must fit the ZIP timestamp range 1980-2107"
    }
    $entryTimestamp = [DateTimeOffset]::FromUnixTimeSeconds($epochSeconds)
    $temporaryArchive = Join-Path $OutputDirectory ".$ArchiveBase.$PID.zip"
    if (Test-Path -LiteralPath $temporaryArchive) { throw "temporary Host archive already exists: $temporaryArchive" }

    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($temporaryArchive, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            $files = @(Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | Sort-Object FullName)
            foreach ($file in $files) {
                $relative = [IO.Path]::GetRelativePath($PackageRoot, $file.FullName).Replace('\', '/')
                $entry = $zip.CreateEntry("$ArchiveBase/$relative", [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $entryTimestamp
                $entry.ExternalAttributes = 0
                $inputStream = $null
                $outputStream = $null
                $inputStream = [IO.File]::OpenRead($file.FullName)
                $outputStream = $entry.Open()
                try {
                    $inputStream.CopyTo($outputStream)
                }
                finally {
                    if ($null -ne $outputStream) { $outputStream.Dispose() }
                    if ($null -ne $inputStream) { $inputStream.Dispose() }
                }
            }
        }
        finally {
            if ($null -ne $zip) { $zip.Dispose() }
        }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    [IO.File]::Move($temporaryArchive, $Archive)
    $Hash = Get-FileHash -Algorithm SHA256 $Archive
    Write-Output ("{0}  {1}" -f $Hash.Hash.ToLowerInvariant(), $Archive)
}
finally {
    if ($null -ne $temporaryArchive -and (Test-Path -LiteralPath $temporaryArchive)) {
        Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
}
