[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("install", "upgrade", "rollback", "doctor", "uninstall")]
    [string]$Action,
    [string]$SourceDirectory,
    [string]$DaemonConfig,
    [string]$NodeConfig,
    [string]$SignerThumbprint,
    [string]$InstallRoot = (Join-Path $env:ProgramData "zapVM\Host")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$DaemonService = "zapvm-daemon"
$NodeService = "zapvm-node"
$HCSService = "zapvm"
$StateFileName = "host-state.json"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run from an elevated Administrator PowerShell."
    }
}

function Get-NormalizedThumbprint([string]$Value) {
    $normalized = ($Value -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    if ($normalized.Length -lt 40) { throw "SignerThumbprint is invalid." }
    return $normalized
}

function Assert-SafeRoot([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { throw "ProgramData is unavailable." }
    $programData = [IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not ($full + '\').StartsWith($programData, [StringComparison]::OrdinalIgnoreCase)) {
        throw "InstallRoot must remain inside ProgramData."
    }
    if ($full -eq $programData.TrimEnd('\')) { throw "InstallRoot cannot be ProgramData itself." }
    $cursor = $full
    while ($cursor.Length -ge $programData.TrimEnd('\').Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "InstallRoot cannot traverse reparse point $cursor."
            }
        }
        if ($cursor.Equals($programData.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Path $cursor -Parent
        if ($parent -eq $cursor -or [string]::IsNullOrWhiteSpace($parent)) { throw "InstallRoot ancestry is invalid." }
        $cursor = $parent.TrimEnd('\')
    }
    return $full
}

function Assert-RegularFile([string]$Path, [string]$Label) {
    if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw "$Label must be absolute." }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label must be a regular non-reparse file."
    }
    return $item.FullName
}

function Assert-RealDirectory([string]$Path, [string]$Label) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label must be a real directory."
    }
    return $item.FullName
}

function Invoke-ICacls([string[]]$Arguments) {
    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE." }
}

function Protect-Directory([string]$Path) {
    Invoke-ICacls @($Path, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F")
    Invoke-ICacls @($Path, "/setowner", "*S-1-5-32-544")
}

function Protect-File([string]$Path) {
    Invoke-ICacls @($Path, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F")
    Invoke-ICacls @($Path, "/setowner", "*S-1-5-32-544")
}

function Assert-ServiceAuthorityACL([string]$Path, [string]$Label) {
    $full = Assert-RegularFile $Path $Label
    foreach ($candidate in @($full, (Split-Path -Path $full -Parent))) {
        $item = Get-Item -LiteralPath $candidate -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label cannot traverse a reparse point." }
        $acl = Get-Acl -LiteralPath $candidate
        try { $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { throw "$Label owner cannot be resolved to a SID." }
        if ($owner -notin @("S-1-5-18", "S-1-5-32-544")) { throw "$Label owner must be LocalSystem or Administrators for LocalSystem service use." }
        $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $rule.IdentityReference.Value -notin @("S-1-5-18", "S-1-5-32-544")) {
                throw "$Label grants access to unexpected SID $($rule.IdentityReference.Value)."
            }
        }
    }
    return $full
}

function Assert-Authenticode([string]$Path, [string]$ExpectedThumbprint) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
        throw "Authenticode validation failed for $Path with status $($signature.Status)."
    }
    $actual = Get-NormalizedThumbprint $signature.SignerCertificate.Thumbprint
    if ($actual -ne $ExpectedThumbprint) { throw "Unexpected Authenticode signer for $Path." }
}

function Invoke-ZapVM([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE." }
}

function Get-ReleaseVersion([string]$ZapVM, [string]$Node) {
    $zapVersion = (& $ZapVM version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "zapvm version failed." }
    $nodeVersion = (& $Node --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "zapvm-node --version failed." }
    if ($zapVersion -ne $nodeVersion) { throw "zapvm and zapvm-node versions differ." }
    if ($zapVersion.Length -gt 128 -or $zapVersion -notmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$') {
        throw "Release version is invalid."
    }
    return $zapVersion
}

function Assert-WindowsCapabilities {
    Assert-Administrator
    if ([Environment]::OSVersion.Version.Build -lt 20348) { throw "Windows build 20348+ is required." }
    foreach ($name in @("vmcompute", "hns")) {
        if ($null -eq (Get-Service -Name $name -ErrorAction SilentlyContinue)) { throw "Required service $name is unavailable." }
    }
}

function Assert-WindowsRuntime([string]$ZapVM) {
    Assert-WindowsCapabilities
    Invoke-ZapVM $ZapVM @("doctor")
}

function Get-ServiceRecord([string]$Name) {
    return Get-CimInstance -ClassName Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
}

function Get-DaemonCommand([string]$ReleasePath) {
    return ('"{0}" daemon service-run --config "{1}"' -f (Join-Path $ReleasePath "zapvm.exe"), (Join-Path $ReleasePath "daemon.json"))
}

function Get-NodeCommand([string]$ReleasePath) {
    return ('"{0}" --service-run --config "{1}"' -f (Join-Path $ReleasePath "zapvm-node.exe"), (Join-Path $ReleasePath "cloud-node.json"))
}

function Invoke-SC([string[]]$Arguments) {
    & sc.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe $($Arguments[0]) failed with exit code $LASTEXITCODE." }
}

function Install-ManagedService([string]$Name, [string]$DisplayName, [string]$BinaryPath, [string[]]$Dependencies) {
    if ($null -ne (Get-ServiceRecord $Name)) { throw "Service $Name already exists." }
    New-Service -Name $Name -BinaryPathName $BinaryPath -DisplayName $DisplayName -StartupType Automatic -DependsOn $Dependencies | Out-Null
    Invoke-SC @("sidtype", $Name, "unrestricted")
}

function Set-ManagedServicePath([string]$Name, [string]$BinaryPath) {
    Invoke-SC @("config", $Name, "binPath=", $BinaryPath, "start=", "auto", "obj=", "LocalSystem")
}

function Set-ServiceRecovery([string]$Name) {
    Invoke-SC @("failure", $Name, "reset=", "86400", "actions=", 'restart/10000/restart/10000/""/0')
}

function Stop-ManagedService([string]$Name) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $service -or $service.Status -eq [ServiceProcess.ServiceControllerStatus]::Stopped) { return }
    Stop-Service -Name $Name -Force
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
}

function Remove-ManagedService([string]$Name) {
    if ($null -eq (Get-ServiceRecord $Name)) { return }
    Stop-ManagedService $Name
    Invoke-SC @("delete", $Name)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($null -ne (Get-ServiceRecord $Name)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out deleting service $Name." }
        Start-Sleep -Milliseconds 250
    }
}

function Stop-HostServices {
    Stop-ManagedService $NodeService
    Stop-ManagedService $DaemonService
}

function Start-StableService([string]$Name) {
    $service = Get-Service -Name $Name
    if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
        Start-Service -Name $Name
    }
    $service.Refresh()
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
    $first = Get-ServiceRecord $Name
    if ($null -eq $first -or $first.State -ne "Running" -or [uint32]$first.ProcessId -eq 0) { throw "Service $Name did not reach Running." }
    $servicePID = [uint32]$first.ProcessId
    Start-Sleep -Seconds 3
    $second = Get-ServiceRecord $Name
    if ($null -eq $second -or $second.State -ne "Running" -or [uint32]$second.ProcessId -ne $servicePID) {
        throw "Service $Name was not stable for the health window."
    }
}

function Start-HostServices([string]$ReleasePath) {
    Start-StableService $DaemonService
    Invoke-ZapVM (Join-Path $ReleasePath "zapvm.exe") @("daemon", "status", "--config", (Join-Path $ReleasePath "daemon.json"))
    Start-StableService $NodeService
}

function Assert-ServiceContract([string]$Name, [string]$ExpectedPath) {
    $record = Get-ServiceRecord $Name
    if ($null -eq $record) { throw "Service $Name is missing." }
    if ($record.StartName -ne "LocalSystem" -or $record.StartMode -ne "Auto") { throw "Service $Name has an unsafe account or start mode." }
    if ($record.PathName -ne $ExpectedPath) { throw "Service $Name command line differs from the managed contract." }
}

function Read-HostState([string]$StatePath) {
    Assert-RegularFile $StatePath "host state" | Out-Null
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($state.schema_version -ne 1 -or [string]::IsNullOrWhiteSpace($state.current)) { throw "Host state is invalid." }
    foreach ($version in @([string]$state.current, [string]$state.previous)) {
        if (-not [string]::IsNullOrWhiteSpace($version) -and ($version.Length -gt 128 -or $version -notmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$')) {
            throw "Host state contains an invalid release version."
        }
    }
    return $state
}

function Write-HostState([string]$StatePath, [string]$Current, [string]$Previous, [string]$Thumbprint) {
    $payload = [ordered]@{ schema_version = 1; current = $Current; previous = $Previous; signer_thumbprint = $Thumbprint }
    $temp = "$StatePath.$([Guid]::NewGuid().ToString('N')).tmp"
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
    Protect-File $temp
    Move-Item -LiteralPath $temp -Destination $StatePath -Force
    Protect-File $StatePath
}

function Assert-Release([string]$ReleasePath, [string]$Thumbprint, [string]$ExpectedVersion = "") {
    $zap = Assert-RegularFile (Join-Path $ReleasePath "zapvm.exe") "zapvm.exe"
    $node = Assert-RegularFile (Join-Path $ReleasePath "zapvm-node.exe") "zapvm-node.exe"
    Assert-Authenticode $zap $Thumbprint
    Assert-Authenticode $node $Thumbprint
    $version = Get-ReleaseVersion $zap $node
    $directoryVersion = if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { Split-Path $ReleasePath -Leaf } else { $ExpectedVersion }
    if ($directoryVersion -ne $version) { throw "Release directory and binary version differ." }
    $daemon = Assert-RegularFile (Join-Path $ReleasePath "daemon.json") "daemon config"
    $nodeConfigPath = Assert-RegularFile (Join-Path $ReleasePath "cloud-node.json") "node config"
    Invoke-ZapVM $zap @("daemon", "run", "--config", $daemon, "--validate")
    Invoke-ZapVM $node @("--config", $nodeConfigPath, "--validate")
    $daemonEndpoint = (& $zap daemon run --config $daemon --print-endpoint | Out-String).Trim()
    $nodeEndpoint = (& $node --config $nodeConfigPath --print-daemon-endpoint | Out-String).Trim()
    if ($daemonEndpoint -ne $nodeEndpoint -or -not $daemonEndpoint.StartsWith("\\.\pipe\zapvm-", [StringComparison]::OrdinalIgnoreCase)) {
        throw "daemon and node must use the same explicit zapvm named pipe endpoint."
    }
    return $version
}

function Stage-Release([string]$Root, [string]$Thumbprint) {
    if ([string]::IsNullOrWhiteSpace($SourceDirectory) -or [string]::IsNullOrWhiteSpace($DaemonConfig) -or [string]::IsNullOrWhiteSpace($NodeConfig)) {
        throw "install/upgrade require SourceDirectory, DaemonConfig and NodeConfig."
    }
    $source = Assert-RealDirectory ([IO.Path]::GetFullPath($SourceDirectory)) "source directory"
    $sourceZap = Assert-RegularFile (Join-Path $source "zapvm.exe") "source zapvm.exe"
    $sourceNode = Assert-RegularFile (Join-Path $source "zapvm-node.exe") "source zapvm-node.exe"
    $daemonSource = Assert-RegularFile ([IO.Path]::GetFullPath($DaemonConfig)) "daemon config source"
    $nodeSource = Assert-RegularFile ([IO.Path]::GetFullPath($NodeConfig)) "node config source"
    $daemonAuthority = Get-Content -LiteralPath $daemonSource -Raw | ConvertFrom-Json
    $nodeAuthority = Get-Content -LiteralPath $nodeSource -Raw | ConvertFrom-Json
    Assert-ServiceAuthorityACL ([string]$daemonAuthority.image_public_key) "image public key" | Out-Null
    $credentialProperty = $daemonAuthority.PSObject.Properties["credentials"]
    if ($null -ne $credentialProperty) {
        foreach ($binding in @($credentialProperty.Value)) {
            Assert-ServiceAuthorityACL ([string]$binding.path) "credential source" | Out-Null
        }
    }
    foreach ($path in @([string]$nodeAuthority.server_ca, [string]$nodeAuthority.certificate, [string]$nodeAuthority.private_key)) {
        Assert-ServiceAuthorityACL $path "Node mTLS authority" | Out-Null
    }
    Assert-Authenticode $sourceZap $Thumbprint
    Assert-Authenticode $sourceNode $Thumbprint
    $version = Get-ReleaseVersion $sourceZap $sourceNode
    $destination = Join-Path (Join-Path $Root "releases") $version
    if (Test-Path -LiteralPath $destination) {
        Assert-Release $destination $Thumbprint | Out-Null
        foreach ($pair in @(@($sourceZap, "zapvm.exe"), @($sourceNode, "zapvm-node.exe"), @($daemonSource, "daemon.json"), @($nodeSource, "cloud-node.json"))) {
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $pair[0]).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $destination $pair[1])).Hash) {
                throw "Release $version already exists with different content."
            }
        }
        return $destination
    }
    $staging = Join-Path (Join-Path $Root "releases") (".$version.partial-" + [Guid]::NewGuid().ToString("N"))
    try {
        New-Item -ItemType Directory -Path $staging | Out-Null
        Protect-Directory $staging
        Copy-Item -LiteralPath $sourceZap -Destination (Join-Path $staging "zapvm.exe")
        Copy-Item -LiteralPath $sourceNode -Destination (Join-Path $staging "zapvm-node.exe")
        Copy-Item -LiteralPath $daemonSource -Destination (Join-Path $staging "daemon.json")
        Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $staging "cloud-node.json")
        Get-ChildItem -LiteralPath $staging -File | ForEach-Object { Protect-File $_.FullName }
        Assert-Release $staging $Thumbprint $version | Out-Null
        Move-Item -LiteralPath $staging -Destination $destination
    } catch {
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force
        }
        throw
    }
    Assert-Release $destination $Thumbprint | Out-Null
    return $destination
}

function Initialize-Root([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
    Assert-RealDirectory $Root "install root" | Out-Null
    Protect-Directory $Root
    $releases = Join-Path $Root "releases"
    if (-not (Test-Path -LiteralPath $releases)) { New-Item -ItemType Directory -Path $releases | Out-Null }
    Assert-RealDirectory $releases "releases directory" | Out-Null
    Protect-Directory $releases
}

$Root = Assert-SafeRoot $InstallRoot
$StatePath = Join-Path $Root $StateFileName
Assert-Administrator

switch ($Action) {
    "install" {
        if ([string]::IsNullOrWhiteSpace($SignerThumbprint)) { throw "install requires SignerThumbprint." }
        $thumbprint = Get-NormalizedThumbprint $SignerThumbprint
        Initialize-Root $Root
        if (Test-Path -LiteralPath $StatePath) { throw "Host is already installed; use upgrade." }
        foreach ($name in @($HCSService, $DaemonService, $NodeService)) {
            if ($null -ne (Get-ServiceRecord $name)) { throw "Refusing to replace pre-existing service $name." }
        }
        $release = Stage-Release $Root $thumbprint
        $zap = Join-Path $release "zapvm.exe"
        Assert-WindowsCapabilities
        $hcsInstalled = $false
        try {
            Invoke-ZapVM $zap @("service", "install")
            $hcsInstalled = $true
            Assert-WindowsRuntime $zap
            Install-ManagedService $DaemonService "zapVM Agent Computer Daemon" (Get-DaemonCommand $release) @($HCSService)
            Install-ManagedService $NodeService "zapVM Cloud Node" (Get-NodeCommand $release) @($DaemonService, "Tcpip")
            Start-HostServices $release
            Set-ServiceRecovery $DaemonService
            Set-ServiceRecovery $NodeService
            Write-HostState $StatePath (Split-Path $release -Leaf) "" $thumbprint
        } catch {
            Remove-ManagedService $NodeService
            Remove-ManagedService $DaemonService
            if ($hcsInstalled) { & $zap service uninstall | Out-Null }
            throw
        }
        Write-Output "ZAPVM_WINDOWS_HOST_OK action=install version=$(Split-Path $release -Leaf) root=$Root"
    }
    "upgrade" {
        if (-not (Test-Path -LiteralPath $StatePath)) { throw "Host is not installed." }
        $state = Read-HostState $StatePath
        $thumbprint = Get-NormalizedThumbprint $state.signer_thumbprint
        if (-not [string]::IsNullOrWhiteSpace($SignerThumbprint) -and (Get-NormalizedThumbprint $SignerThumbprint) -ne $thumbprint) {
            throw "Upgrade signer differs from the installed trust anchor."
        }
        $oldRelease = Join-Path (Join-Path $Root "releases") $state.current
        Assert-Release $oldRelease $thumbprint | Out-Null
        $newRelease = Stage-Release $Root $thumbprint
        if ($newRelease -eq $oldRelease) { throw "Requested version is already active." }
        $newZap = Join-Path $newRelease "zapvm.exe"
        Assert-WindowsRuntime (Join-Path $oldRelease "zapvm.exe")
        Stop-HostServices
        $hcsUpgraded = $false
        try {
            Invoke-ZapVM $newZap @("service", "upgrade")
            $hcsUpgraded = $true
            Set-ManagedServicePath $DaemonService (Get-DaemonCommand $newRelease)
            Set-ManagedServicePath $NodeService (Get-NodeCommand $newRelease)
            Start-HostServices $newRelease
            Set-ServiceRecovery $DaemonService
            Set-ServiceRecovery $NodeService
            Write-HostState $StatePath (Split-Path $newRelease -Leaf) $state.current $thumbprint
        } catch {
            Stop-HostServices
            Set-ManagedServicePath $DaemonService (Get-DaemonCommand $oldRelease)
            Set-ManagedServicePath $NodeService (Get-NodeCommand $oldRelease)
            if ($hcsUpgraded) { Invoke-ZapVM $newZap @("service", "rollback") }
            Start-HostServices $oldRelease
            throw "Upgrade failed; previous release was restored. $($_.Exception.Message)"
        }
        Write-Output "ZAPVM_WINDOWS_HOST_OK action=upgrade version=$(Split-Path $newRelease -Leaf) root=$Root"
    }
    "rollback" {
        $state = Read-HostState $StatePath
        if ([string]::IsNullOrWhiteSpace($state.previous)) { throw "No previous release is available." }
        $thumbprint = Get-NormalizedThumbprint $state.signer_thumbprint
        $currentRelease = Join-Path (Join-Path $Root "releases") $state.current
        $previousRelease = Join-Path (Join-Path $Root "releases") $state.previous
        Assert-Release $currentRelease $thumbprint | Out-Null
        Assert-Release $previousRelease $thumbprint | Out-Null
        Stop-HostServices
        $hcsRolledBack = $false
        try {
            Invoke-ZapVM (Join-Path $currentRelease "zapvm.exe") @("service", "rollback")
            $hcsRolledBack = $true
            Set-ManagedServicePath $DaemonService (Get-DaemonCommand $previousRelease)
            Set-ManagedServicePath $NodeService (Get-NodeCommand $previousRelease)
            Start-HostServices $previousRelease
            Write-HostState $StatePath $state.previous $state.current $thumbprint
        } catch {
            Stop-HostServices
            Set-ManagedServicePath $DaemonService (Get-DaemonCommand $currentRelease)
            Set-ManagedServicePath $NodeService (Get-NodeCommand $currentRelease)
            if ($hcsRolledBack) { Invoke-ZapVM (Join-Path $previousRelease "zapvm.exe") @("service", "rollback") }
            Start-HostServices $currentRelease
            throw "Rollback failed; current release was restored. $($_.Exception.Message)"
        }
        Write-Output "ZAPVM_WINDOWS_HOST_OK action=rollback version=$($state.previous) root=$Root"
    }
    "doctor" {
        $state = Read-HostState $StatePath
        $thumbprint = Get-NormalizedThumbprint $state.signer_thumbprint
        $release = Join-Path (Join-Path $Root "releases") $state.current
        Assert-Release $release $thumbprint | Out-Null
        $zap = Join-Path $release "zapvm.exe"
        Assert-WindowsRuntime $zap
        Assert-ServiceContract $DaemonService (Get-DaemonCommand $release)
        Assert-ServiceContract $NodeService (Get-NodeCommand $release)
        Invoke-ZapVM $zap @("service", "status")
        Start-HostServices $release
        Write-Output "ZAPVM_WINDOWS_HOST_OK action=doctor version=$($state.current) root=$Root"
    }
    "uninstall" {
        $state = Read-HostState $StatePath
        $release = Join-Path (Join-Path $Root "releases") $state.current
        $thumbprint = Get-NormalizedThumbprint $state.signer_thumbprint
        Assert-Release $release $thumbprint | Out-Null
        Stop-HostServices
        Remove-ManagedService $NodeService
        Remove-ManagedService $DaemonService
        Invoke-ZapVM (Join-Path $release "zapvm.exe") @("service", "uninstall")
        Remove-Item -LiteralPath $StatePath -Force
        Write-Output "ZAPVM_WINDOWS_HOST_OK action=uninstall retained=$Root"
    }
}
