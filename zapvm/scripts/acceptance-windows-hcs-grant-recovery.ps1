param(
    [Parameter(Mandatory = $true)][string]$ImageRoot,
    [Parameter(Mandatory = $true)][string]$ImagePublicKey,
    [Parameter(Mandatory = $true)][string]$StateTemplate,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
    [string]$FaultZapVMExecutable = ""
)

$ErrorActionPreference = "Stop"
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)) {
    $PSNativeCommandUseErrorActionPreference = $false
}
foreach ($name in @("ImageRoot", "ImagePublicKey", "StateTemplate", "Workspace", "EvidenceDirectory")) {
    $value = Get-Variable -Name $name -ValueOnly
    if (-not [IO.Path]::IsPathFullyQualified($value)) { throw "$name must be an absolute path: $value" }
}
if (-not [string]::IsNullOrWhiteSpace($FaultZapVMExecutable) -and -not [IO.Path]::IsPathFullyQualified($FaultZapVMExecutable)) {
    throw "FaultZapVMExecutable must be an absolute path"
}
if (-not (Test-Path -LiteralPath $ImageRoot -PathType Container)) { throw "Missing image root: $ImageRoot" }
if (-not (Test-Path -LiteralPath $ImagePublicKey -PathType Leaf)) { throw "Missing image public key: $ImagePublicKey" }
if (-not (Test-Path -LiteralPath $StateTemplate -PathType Leaf)) { throw "Missing state template: $StateTemplate" }
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Missing workspace: $Workspace" }
if (Test-Path -LiteralPath $EvidenceDirectory) { throw "Refusing existing evidence directory: $EvidenceDirectory" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "HCS grant recovery acceptance requires an elevated Administrator PowerShell"
}
if ($null -ne (Get-Service -Name "zapvm" -ErrorAction SilentlyContinue)) {
    throw "Refusing to modify a pre-existing zapvm service"
}

$RepoDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
New-Item -ItemType Directory -Path $EvidenceDirectory | Out-Null
$FaultZapVM = Join-Path $EvidenceDirectory "zapvm-fault.exe"
if ([string]::IsNullOrWhiteSpace($FaultZapVMExecutable)) {
    Push-Location $RepoDirectory
    try {
        & go build -trimpath -tags acceptance_fault_injection -ldflags "-X main.version=0.1.0-acceptance-fault" -o $FaultZapVM ./cmd/zapvm
        if ($LASTEXITCODE -ne 0) { throw "fault-enabled zapvm build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} else {
    $FaultZapVMExecutable = [IO.Path]::GetFullPath($FaultZapVMExecutable)
    if (-not (Test-Path -LiteralPath $FaultZapVMExecutable -PathType Leaf)) { throw "Missing fault zapvm: $FaultZapVMExecutable" }
    Copy-Item -LiteralPath $FaultZapVMExecutable -Destination $FaultZapVM
}

$ProgramDataDirectory = Join-Path $env:ProgramData "zapVM"
$JournalPath = Join-Path $ProgramDataDirectory "hcs-grants.json"
$FaultConfigPath = Join-Path $ProgramDataDirectory "acceptance-fault.json"
$FaultConsumedPath = Join-Path $ProgramDataDirectory "acceptance-fault-consumed.json"
$FaultMarkerPath = Join-Path $ProgramDataDirectory "acceptance-fault-hit.json"
foreach ($path in @($JournalPath, $FaultConfigPath, $FaultConsumedPath, $FaultMarkerPath)) {
    if (Test-Path -LiteralPath $path) { throw "Refusing stale HCS recovery fixture: $path" }
}

$Active = Get-Content -Raw -LiteralPath (Join-Path $ImageRoot "active.json") | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Active.active_version)) { throw "Active image version is missing" }
$ActiveImage = Join-Path $ImageRoot $Active.active_version
$KnownGrantPaths = @(
    Join-Path $ActiveImage "kernel"
    Join-Path $ActiveImage "initramfs"
    Join-Path $ActiveImage "rootfs.vhdx"
    $Workspace
)
foreach ($path in $KnownGrantPaths) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing known HCS grant path: $path" }
}

function Get-Sddl([string]$Path) {
    return (Get-Acl -LiteralPath $Path).Sddl
}

function Get-DaclSddl([string]$Path) {
    return (Get-Acl -LiteralPath $Path).GetSecurityDescriptorSddlForm(
        [Security.AccessControl.AccessControlSections]::Access
    )
}

function Get-VirtualMachineAceSids([string]$Path) {
    $result = [Collections.Generic.List[string]]::new()
    $acl = Get-Acl -LiteralPath $Path
    foreach ($rule in $acl.Access) {
        try {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        } catch {
            $sid = $rule.IdentityReference.Value
        }
        if ($sid -match '^S-1-5-83-') { $result.Add($sid) }
    }
    return @($result)
}

function Assert-NoVirtualMachineAce([string]$Path) {
    $sids = @(Get-VirtualMachineAceSids $Path)
    if ($sids.Count -ne 0) {
        throw "HCS virtual-machine ACE remains on $Path`: $($sids -join ',')"
    }
}

function Assert-HasVirtualMachineAce([string]$Path) {
    $sids = @(Get-VirtualMachineAceSids $Path)
    if ($sids.Count -eq 0) {
        throw "Expected an HCS virtual-machine ACE on $Path"
    }
}

function Wait-ServiceStopped {
    foreach ($attempt in 1..300) {
        $service = Get-Service -Name "zapvm" -ErrorAction SilentlyContinue
        if ($null -ne $service -and $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Stopped) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "zapvm service did not reach Stopped after fault injection"
}

function Write-FaultConfig([string]$Point, [int]$GrantIndex, [string]$Nonce) {
    $document = [ordered]@{ version = 1; point = $Point; grant_index = $GrantIndex; nonce = $Nonce }
    $json = $document | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($FaultConfigPath, $json, [Text.UTF8Encoding]::new($false))
}

$Faults = @(
    [PSCustomObject]@{ Point = "after-journal-prepare"; GrantIndex = -1; GrantedCount = 0; Pending = $false; PendingAccess = "none" }
    foreach ($index in 0..5) {
        [PSCustomObject]@{ Point = "after-grant-intent"; GrantIndex = $index; GrantedCount = $index; Pending = $true; PendingAccess = "absent" }
        [PSCustomObject]@{ Point = "after-grant-call"; GrantIndex = $index; GrantedCount = $index; Pending = $true; PendingAccess = "present" }
        [PSCustomObject]@{ Point = "after-grant"; GrantIndex = $index; GrantedCount = $index + 1; Pending = $false; PendingAccess = "none" }
    }
    [PSCustomObject]@{ Point = "after-hcs-create"; GrantIndex = -1; GrantedCount = 6; Pending = $false; PendingAccess = "none"; ReplayRecovery = $true }
    [PSCustomObject]@{ Point = "after-hcs-start"; GrantIndex = -1; GrantedCount = 6; Pending = $false; PendingAccess = "none" }
)
$Results = [Collections.Generic.List[object]]::new()
try {
    $guardLog = Join-Path $EvidenceDirectory "fault-install-guard.log"
    & $FaultZapVM service install *> $guardLog
    if ($LASTEXITCODE -eq 0) { throw "fault-enabled service installed without explicit confirmation" }
    if ($null -ne (Get-Service -Name "zapvm" -ErrorAction SilentlyContinue)) { throw "guarded install created a service" }
    if (-not (Select-String -Quiet -SimpleMatch "ZAPVM_ACCEPTANCE_ALLOW_FAULT_SERVICE" -LiteralPath $guardLog)) {
        throw "fault-enabled install guard returned an unexpected error"
    }

    $env:ZAPVM_ACCEPTANCE_ALLOW_FAULT_SERVICE = "I_UNDERSTAND_THIS_SERVICE_WILL_TERMINATE_ITSELF"
    try {
        & $FaultZapVM service install 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "service-install.log")
        if ($LASTEXITCODE -ne 0) { throw "fault service install failed with exit code $LASTEXITCODE" }
    } finally {
        Remove-Item Env:ZAPVM_ACCEPTANCE_ALLOW_FAULT_SERVICE -ErrorAction SilentlyContinue
    }
    $caseNumber = 0
    foreach ($fault in $Faults) {
        $caseNumber++
        $caseName = "{0:D2}-{1}-{2}" -f $caseNumber, $fault.Point, $fault.GrantIndex
        $caseDirectory = Join-Path $EvidenceDirectory $caseName
        New-Item -ItemType Directory -Path $caseDirectory | Out-Null
        $stateDisk = Join-Path $caseDirectory "state.vhdx"
        & $FaultZapVM state create --template $StateTemplate --output $stateDisk --format vhdx --schema 2 *> (Join-Path $caseDirectory "state-create.log")
        if ($LASTEXITCODE -ne 0) { throw "$caseName state create failed" }

        # Make the normally ephemeral bootstrap share an explicit fixture so
        # its pre-grant DACL is independently captured for grant index 4.
        $bootShare = Join-Path $caseDirectory "bootstrap"
        New-Item -ItemType Directory -Path $bootShare | Out-Null
        [IO.File]::WriteAllBytes(
            (Join-Path $bootShare "rpc-secret"),
            [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
        )
        $bootstrapIdentity = [ordered]@{ uid = 1000; gid = 1000; network_mode = "off" } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText(
            (Join-Path $bootShare "identity.json"),
            $bootstrapIdentity,
            [Text.UTF8Encoding]::new($false)
        )

        $baseline = [ordered]@{}
        $baselineDacl = [ordered]@{}
        foreach ($path in @($KnownGrantPaths + $stateDisk + $bootShare)) {
            Assert-NoVirtualMachineAce $path
            $baseline[$path] = Get-Sddl $path
            $baselineDacl[$path] = Get-DaclSddl $path
        }
        $baseline | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseDirectory "acl-baseline.json") -Encoding utf8
        $baselineDacl | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseDirectory "dacl-baseline.json") -Encoding utf8

        $nonce = "fault-$env:GITHUB_RUN_ID-$caseNumber-$PID"
        Write-FaultConfig -Point $fault.Point -GrantIndex $fault.GrantIndex -Nonce $nonce
        $runLog = Join-Path $caseDirectory "run.log"
        $arguments = @(
            "run", "--id", "windows-grant-fault-$caseNumber", "--image-root", $ImageRoot,
            "--image-public-key", $ImagePublicKey, "--state-disk", $stateDisk,
            "--workspace", $Workspace, "--boot-share", $bootShare,
            "--network", "off", "--console=true", "--stop-after-exec",
            "--", "/bin/sh", "-c", "echo UNEXPECTED_FAULT_COMPLETION"
        )
        & $FaultZapVM @arguments *> $runLog
        if ($LASTEXITCODE -eq 0) { throw "$caseName unexpectedly completed without service termination" }
        Wait-ServiceStopped

        if (-not (Test-Path -LiteralPath $FaultMarkerPath -PathType Leaf)) { throw "$caseName did not persist a fault marker" }
        $marker = Get-Content -Raw -LiteralPath $FaultMarkerPath | ConvertFrom-Json
        if ($marker.nonce -ne $nonce -or $marker.point -ne $fault.Point -or [int]$marker.grant_index -ne $fault.GrantIndex) {
            throw "$caseName fault marker mismatch"
        }
        if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) { throw "$caseName did not leave a recovery journal" }
        Copy-Item -LiteralPath $JournalPath -Destination (Join-Path $caseDirectory "journal-after-crash.json")
        $journal = Get-Content -Raw -LiteralPath $JournalPath | ConvertFrom-Json
        if ([int]$journal.version -ne 3) { throw "$caseName journal is not schema 3" }
        $entries = @($journal.entries.PSObject.Properties)
        if ($entries.Count -ne 1) { throw "$caseName journal entry count is $($entries.Count), want 1" }
        $grantedPaths = @($entries[0].Value.granted_paths)
        if ($grantedPaths.Count -ne $fault.GrantedCount) {
            throw "$caseName recorded $($grantedPaths.Count) grants, want $($fault.GrantedCount)"
        }
        $grantedDaclsProperty = $entries[0].Value.PSObject.Properties["granted_dacls"]
        if ($null -eq $grantedDaclsProperty) { throw "$caseName journal omitted granted_dacls" }
        $grantedDacls = @($grantedDaclsProperty.Value)
        if ($grantedDacls.Count -ne $grantedPaths.Count) {
            throw "$caseName recorded $($grantedDacls.Count) DACL baselines for $($grantedPaths.Count) grants"
        }
        if ($grantedPaths.Count -gt 0) {
            foreach ($index in 0..($grantedPaths.Count - 1)) {
                $grantPath = [string]$grantedPaths[$index]
                if ([string]$grantedDacls[$index] -ne [string]$baselineDacl[$grantPath]) {
                    throw "$caseName grant DACL baseline mismatch: $grantPath"
                }
            }
        }
        $pendingProperty = $entries[0].Value.PSObject.Properties["pending_path"]
        $pendingPath = if ($null -eq $pendingProperty) { "" } else { [string]$pendingProperty.Value }
        $pendingDaclProperty = $entries[0].Value.PSObject.Properties["pending_dacl"]
        $pendingDacl = if ($null -eq $pendingDaclProperty) { "" } else { [string]$pendingDaclProperty.Value }
        if ($fault.Pending -and [string]::IsNullOrWhiteSpace($pendingPath)) {
            throw "$caseName did not retain the ambiguous pending grant"
        }
        if (-not $fault.Pending -and -not [string]::IsNullOrWhiteSpace($pendingPath)) {
            throw "$caseName unexpectedly retained pending path $pendingPath"
        }
        if ($fault.Pending -and [string]::IsNullOrWhiteSpace($pendingDacl)) {
            throw "$caseName did not retain the pending DACL baseline"
        }
        if (-not $fault.Pending -and -not [string]::IsNullOrWhiteSpace($pendingDacl)) {
            throw "$caseName unexpectedly retained a pending DACL baseline"
        }
        if ($fault.Pending -and $pendingDacl -ne [string]$baselineDacl[$pendingPath]) {
            throw "$caseName pending DACL baseline mismatch: $pendingPath"
        }
        $aclAfterCrash = [ordered]@{}
        foreach ($path in $grantedPaths) {
            if (Test-Path -LiteralPath $path) {
                Assert-HasVirtualMachineAce $path
                $aclAfterCrash[$path] = Get-Sddl $path
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($pendingPath) -and (Test-Path -LiteralPath $pendingPath)) {
            if ($fault.PendingAccess -eq "present") {
                Assert-HasVirtualMachineAce $pendingPath
            } elseif ($fault.PendingAccess -eq "absent") {
                Assert-NoVirtualMachineAce $pendingPath
            } else {
                throw "$caseName has invalid pending access expectation $($fault.PendingAccess)"
            }
            $aclAfterCrash[$pendingPath] = Get-Sddl $pendingPath
        }
        $aclAfterCrash | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseDirectory "acl-after-crash.json") -Encoding utf8

        Remove-Item -LiteralPath $FaultConsumedPath, $FaultMarkerPath -Force
        if (Test-Path -LiteralPath $FaultConfigPath) { throw "$caseName fault config was not consumed" }

        if ($fault.ReplayRecovery) {
            $recoveryNonce = "recovery-$env:GITHUB_RUN_ID-$caseNumber-$PID"
            Write-FaultConfig -Point "after-recovery-revoke" -GrantIndex 5 -Nonce $recoveryNonce
            & $FaultZapVM service start *> (Join-Path $caseDirectory "service-recovery-interrupted.log")
            Wait-ServiceStopped
            if (-not (Test-Path -LiteralPath $FaultMarkerPath -PathType Leaf)) {
                throw "$caseName did not hit the recovery-replay fault"
            }
            $recoveryMarker = Get-Content -Raw -LiteralPath $FaultMarkerPath | ConvertFrom-Json
            if ($recoveryMarker.nonce -ne $recoveryNonce -or
                $recoveryMarker.point -ne "after-recovery-revoke" -or
                [int]$recoveryMarker.grant_index -ne 5) {
                throw "$caseName recovery-replay marker mismatch"
            }
            if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
                throw "$caseName removed the journal before interrupted recovery completed"
            }
            Copy-Item -LiteralPath $JournalPath -Destination (Join-Path $caseDirectory "journal-after-recovery-crash.json")
            Remove-Item -LiteralPath $FaultConsumedPath, $FaultMarkerPath -Force
            if (Test-Path -LiteralPath $FaultConfigPath) { throw "$caseName recovery fault config was not consumed" }
        }

        & $FaultZapVM service start 2>&1 | Tee-Object -FilePath (Join-Path $caseDirectory "service-recovery.log")
        if ($LASTEXITCODE -ne 0) { throw "$caseName service recovery failed with exit code $LASTEXITCODE" }
        if (Test-Path -LiteralPath $JournalPath) { throw "$caseName recovery journal remains after service restart" }
        & $FaultZapVM doctor *> (Join-Path $caseDirectory "doctor-after-recovery.log")
        if ($LASTEXITCODE -ne 0) { throw "$caseName doctor failed after recovery" }

        foreach ($path in $grantedPaths) {
            if (Test-Path -LiteralPath $path) { Assert-NoVirtualMachineAce $path }
        }
        foreach ($item in $baseline.GetEnumerator()) {
            if ((Get-Sddl $item.Key) -ne $item.Value) { throw "$caseName ACL did not return to baseline: $($item.Key)" }
        }
        $Results.Add([PSCustomObject]@{
            point = $fault.Point
            grant_index = $fault.GrantIndex
            recorded_grants = $grantedPaths.Count
            recorded_dacl_baselines = $grantedDacls.Count
            pending_path = -not [string]::IsNullOrWhiteSpace($pendingPath)
            pending_dacl = -not [string]::IsNullOrWhiteSpace($pendingDacl)
            pending_access_expectation = $fault.PendingAccess
            recovery_replay = [bool]$fault.ReplayRecovery
            journal_recovered = $true
            acl_baseline_restored = $true
        })
    }

    [ordered]@{
        schema_version = 1
        cases = $Results
        fault_install_guard = $true
        all_journals_recovered = $true
        all_acl_baselines_restored = $true
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "assertions.json") -Encoding utf8
    Write-Host "WINDOWS_HCS_GRANT_RECOVERY_OK cases=$($Results.Count) evidence=$EvidenceDirectory"
} finally {
    foreach ($path in @($FaultConfigPath, $FaultConsumedPath, $FaultMarkerPath)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne (Get-Service -Name "zapvm" -ErrorAction SilentlyContinue)) {
        & $FaultZapVM service uninstall *> (Join-Path $EvidenceDirectory "service-uninstall.log")
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "fault service uninstall failed with exit code $LASTEXITCODE; journal and ACL state were retained for manual recovery"
        }
    }
}
