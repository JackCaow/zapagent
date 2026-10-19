param(
    [string]$EvidenceDirectory = "",
    [ValidateSet("amd64", "arm64")]
    [string]$Architecture = "",
    [string]$SignedImageBundle = "",
    [string]$SignedImagePublicKey = "",
    [string]$ZapVMExecutable = "",
    [string]$UpgradeZapVMExecutable = "",
    [string]$ImageToolExecutable = ""
)

$ErrorActionPreference = "Stop"
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Windows acceptance must run from an elevated Administrator PowerShell so it can install the zapVM service."
}
$RepoDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($Architecture)) {
    $Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
}
if ([string]::IsNullOrWhiteSpace($EvidenceDirectory)) {
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
    $EvidenceDirectory = Join-Path $RepoDirectory ".cache\acceptance\windows-$stamp-$PID"
}
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $EvidenceDirectory) {
    throw "Refusing existing evidence directory: $EvidenceDirectory"
}

$Workspace = Join-Path $EvidenceDirectory "workspace"
$DistDirectory = Join-Path $RepoDirectory "dist\$Architecture"
$ZapVM = Join-Path $EvidenceDirectory "zapvm.exe"
$UpgradeZapVM = Join-Path $EvidenceDirectory "zapvm-upgrade.exe"
$ImageTool = Join-Path $EvidenceDirectory "zapvm-image.exe"
$ImageRoot = Join-Path $EvidenceDirectory "images"
$ImagePrivateKey = Join-Path $EvidenceDirectory "image-private.pem"
$ImagePublicKey = Join-Path $EvidenceDirectory "image-public.pem"
$ImageSignature = Join-Path $EvidenceDirectory "manifest.sig"
$StateDisk = Join-Path $EvidenceDirectory "state.vhdx"
$DaemonAcceptance = Join-Path $PSScriptRoot "acceptance-daemon-windows.ps1"
New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
if (-not (Test-Path -LiteralPath $DaemonAcceptance -PathType Leaf)) { throw "Missing daemon acceptance helper: $DaemonAcceptance" }
if ([string]::IsNullOrWhiteSpace($SignedImageBundle) -xor [string]::IsNullOrWhiteSpace($SignedImagePublicKey)) {
    throw "SignedImageBundle and SignedImagePublicKey must be provided together."
}
$UseSignedImageBundle = -not [string]::IsNullOrWhiteSpace($SignedImageBundle)
if ($UseSignedImageBundle) {
    $SignedImageBundle = [IO.Path]::GetFullPath($SignedImageBundle)
    $SignedImagePublicKey = [IO.Path]::GetFullPath($SignedImagePublicKey)
    if (-not (Test-Path -LiteralPath $SignedImageBundle -PathType Leaf)) { throw "Missing signed image bundle: $SignedImageBundle" }
    if (-not (Test-Path -LiteralPath $SignedImagePublicKey -PathType Leaf)) { throw "Missing signed image public key: $SignedImagePublicKey" }
} else {
    foreach ($artifact in @("kernel", "initramfs", "rootfs.vhdx", "state.vhdx", "manifest.json")) {
        $path = Join-Path $DistDirectory $artifact
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path" }
    }
    $ManifestDocument = Get-Content -LiteralPath (Join-Path $DistDirectory "manifest.json") -Raw | ConvertFrom-Json
    if ($ManifestDocument.profile -ne "host-runtime" -and -not (Test-Path -LiteralPath (Join-Path $DistDirectory "agent.vhdx") -PathType Leaf)) {
        throw "Missing agent.vhdx in $DistDirectory"
    }
}
$PrebuiltValues = @($ZapVMExecutable, $UpgradeZapVMExecutable, $ImageToolExecutable)
$PrebuiltCount = @($PrebuiltValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
if ($PrebuiltCount -ne 0 -and $PrebuiltCount -ne 3) {
    throw "ZapVMExecutable, UpgradeZapVMExecutable, and ImageToolExecutable must be provided together."
}
$UsePrebuiltExecutables = $PrebuiltCount -eq 3
if ($UsePrebuiltExecutables) {
    $ZapVMExecutable = [IO.Path]::GetFullPath($ZapVMExecutable)
    $UpgradeZapVMExecutable = [IO.Path]::GetFullPath($UpgradeZapVMExecutable)
    $ImageToolExecutable = [IO.Path]::GetFullPath($ImageToolExecutable)
    foreach ($path in @($ZapVMExecutable, $UpgradeZapVMExecutable, $ImageToolExecutable)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing prebuilt executable: $path" }
    }
}

function Start-CapturedZapVM {
    param([string[]]$Arguments, [string]$StdoutPath, [string]$StderrPath)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $ZapVM
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "Unable to start zapvm process" }
    [PSCustomObject]@{
        Process = $process
        StdoutTask = $process.StandardOutput.ReadToEndAsync()
        StderrTask = $process.StandardError.ReadToEndAsync()
        StdoutPath = $StdoutPath
        StderrPath = $StderrPath
        Completed = $false
    }
}

function Complete-CapturedZapVM {
    param($Capture, [switch]$AllowFailure)
    if ($null -eq $Capture -or $Capture.Completed) { return }
    $Capture.Process.WaitForExit()
    [IO.File]::WriteAllText($Capture.StdoutPath, $Capture.StdoutTask.GetAwaiter().GetResult())
    [IO.File]::WriteAllText($Capture.StderrPath, $Capture.StderrTask.GetAwaiter().GetResult())
    $Capture.Completed = $true
    if (-not $AllowFailure -and $Capture.Process.ExitCode -ne 0) {
        throw "zapvm process failed with exit code $($Capture.Process.ExitCode); stderr=$($Capture.StderrPath)"
    }
}

function Stop-CapturedZapVM {
    param($Capture)
    if ($null -eq $Capture -or $Capture.Completed) { return }
    if (-not $Capture.Process.HasExited) {
        try { $Capture.Process.Kill($true) } catch { Write-Warning $_ }
    }
    Complete-CapturedZapVM -Capture $Capture -AllowFailure
}

if ($UsePrebuiltExecutables) {
    Copy-Item -LiteralPath $ZapVMExecutable -Destination $ZapVM
    Copy-Item -LiteralPath $UpgradeZapVMExecutable -Destination $UpgradeZapVM
    Copy-Item -LiteralPath $ImageToolExecutable -Destination $ImageTool
} else {
    Push-Location $RepoDirectory
    try {
        & go build -trimpath -o $ZapVM ./cmd/zapvm
        if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
        & go build -trimpath -ldflags "-X main.version=0.1.0-acceptance-upgrade" -o $UpgradeZapVM ./cmd/zapvm
        if ($LASTEXITCODE -ne 0) { throw "upgrade fixture build failed with exit code $LASTEXITCODE" }
        & go build -trimpath -o $ImageTool ./cmd/zapvm-image
        if ($LASTEXITCODE -ne 0) { throw "zapvm-image build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

$existingService = Get-Service -Name "zapvm" -ErrorAction SilentlyContinue
if ($null -ne $existingService) {
    throw "Refusing to modify pre-existing zapvm service; uninstall or use a clean Windows test host."
}
$ServiceInstalled = $false
try {
& $ZapVM service install 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "service-install.log")
if ($LASTEXITCODE -ne 0) { throw "zapvm service install failed with exit code $LASTEXITCODE" }
$ServiceInstalled = $true
& $ZapVM service status 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "service-status.log")
if ($LASTEXITCODE -ne 0) { throw "zapvm service status failed with exit code $LASTEXITCODE" }
$ServiceBinary = Join-Path $env:ProgramFiles "zapVM\zapvm-service.exe"
$OriginalHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZapVM).Hash
$UpgradeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $UpgradeZapVM).Hash
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ServiceBinary).Hash -ne $OriginalHash) { throw "installed service hash does not match original CLI" }
& $UpgradeZapVM service upgrade 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "service-upgrade.log")
if ($LASTEXITCODE -ne 0) { throw "zapvm service upgrade failed with exit code $LASTEXITCODE" }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ServiceBinary).Hash -ne $UpgradeHash) { throw "upgraded service hash does not match upgrade fixture" }
& $UpgradeZapVM doctor 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "doctor-after-upgrade.log")
if ($LASTEXITCODE -ne 0) { throw "doctor failed after service upgrade with exit code $LASTEXITCODE" }
& $UpgradeZapVM service rollback 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "service-rollback.log")
if ($LASTEXITCODE -ne 0) { throw "zapvm service rollback failed with exit code $LASTEXITCODE" }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ServiceBinary).Hash -ne $OriginalHash) { throw "rolled-back service hash does not match original CLI" }
& $ZapVM doctor 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "doctor.log")
if ($LASTEXITCODE -ne 0) { throw "zapvm doctor failed with exit code $LASTEXITCODE" }
if ($UseSignedImageBundle) {
    $ImagePublicKey = $SignedImagePublicKey
    & $ImageTool install-bundle --bundle $SignedImageBundle --public-key $ImagePublicKey --root $ImageRoot --arch $Architecture --smoke-binary $ZapVM
    if ($LASTEXITCODE -ne 0) { throw "signed image bundle install failed with exit code $LASTEXITCODE" }
    $ActiveImageJSON = & $ImageTool status --root $ImageRoot
    if ($LASTEXITCODE -ne 0) { throw "image status failed with exit code $LASTEXITCODE" }
    $ActiveImage = $ActiveImageJSON | Out-String | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($ActiveImage.active_version)) {
        throw "unable to resolve imported active image version"
    }
    $StateTemplate = Join-Path (Join-Path $ImageRoot $ActiveImage.active_version) "state.vhdx"
} else {
    & $ImageTool keygen --private $ImagePrivateKey --public $ImagePublicKey
    if ($LASTEXITCODE -ne 0) { throw "image keygen failed with exit code $LASTEXITCODE" }
    & $ImageTool sign --manifest (Join-Path $DistDirectory "manifest.json") --private-key $ImagePrivateKey --output $ImageSignature
    if ($LASTEXITCODE -ne 0) { throw "image sign failed with exit code $LASTEXITCODE" }
    Remove-Item -LiteralPath $ImagePrivateKey -Force
    & $ImageTool install --manifest (Join-Path $DistDirectory "manifest.json") --signature $ImageSignature --public-key $ImagePublicKey --destination (Join-Path $ImageRoot "0.1.0-dev")
    if ($LASTEXITCODE -ne 0) { throw "image install failed with exit code $LASTEXITCODE" }
    & $ImageTool activate --root $ImageRoot --version "0.1.0-dev" --public-key $ImagePublicKey
    if ($LASTEXITCODE -ne 0) { throw "image activate failed with exit code $LASTEXITCODE" }
    $StateTemplate = Join-Path $DistDirectory "state.vhdx"
}
& $ZapVM state create --template $StateTemplate --output $StateDisk --format vhdx --schema 3
if ($LASTEXITCODE -ne 0) { throw "state create failed with exit code $LASTEXITCODE" }

$Common = @(
    "--image-root", $ImageRoot,
    "--image-public-key", $ImagePublicKey,
    "--state-disk", $StateDisk,
    "--workspace", $Workspace,
    "--cmdline", "console=hvc0 root=/dev/vda ro rootfstype=ext4 modules=ext4,sd_mod,scsi_mod,hv_storvsc,9p,9pnet,9pnet_virtio,hv_sock",
    "--console=true", "--stop-after-exec"
)

& $ZapVM run @Common --id windows-accept-write --session-id acceptance-a --network off `
    --restart-agent-before-exec -- /bin/sh -c 'set -eu; printf "guest_uid=%s guest_gid=%s cwd=%s workspace_owner=%s state_owner=%s\n" "$(id -u)" "$(id -g)" "$PWD" "$(stat -c %u:%g:%a .)" "$(stat -c %u:%g:%a /var/lib/zapvm/data)"; test "$(id -u)" -eq 1000; test "$PWD" = /workspace; printf "workspace-ok\n" >platform-acceptance; printf "home-a-ok\n" >"$HOME/platform-acceptance"; printf "state-ok\n" >/var/lib/zapvm/data/platform-acceptance; sync; echo WINDOWS_WRITE_RESTART_OK' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "write.log")
if ($LASTEXITCODE -ne 0) { throw "initial VM acceptance failed with exit code $LASTEXITCODE" }
if ((Get-Content -Raw (Join-Path $Workspace "platform-acceptance")).Trim() -ne "workspace-ok") { throw "workspace write did not persist" }
$serviceAfterWrite = Get-CimInstance Win32_Service -Filter "Name='zapvm'" -ErrorAction Stop
$serviceAfterWrite | Select-Object Name, State, Status, ExitCode, ProcessId, StartMode, PathName |
    Format-List | Out-File -LiteralPath (Join-Path $EvidenceDirectory "service-after-write.txt") -Encoding utf8
if ($serviceAfterWrite.State -ne "Running") {
    throw "zapVM service stopped after the first VM (state=$($serviceAfterWrite.State) exit=$($serviceAfterWrite.ExitCode))"
}

& $ZapVM run @Common --id windows-accept-persist --session-id acceptance-a --network off -- /bin/sh -c 'set -eu; test "$(cat platform-acceptance)" = workspace-ok; test "$(cat "$HOME/platform-acceptance")" = home-a-ok; test "$(cat /var/lib/zapvm/data/platform-acceptance)" = state-ok; echo WINDOWS_PERSISTENCE_OK' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "persistence.log")
if ($LASTEXITCODE -ne 0) { throw "persistence acceptance failed with exit code $LASTEXITCODE" }

& $ZapVM run @Common --id windows-accept-isolation --session-id acceptance-b --network off -- /bin/sh -c 'set -eu; test ! -e "$HOME/platform-acceptance"; test "$(cat /var/lib/zapvm/data/platform-acceptance)" = state-ok; echo WINDOWS_SESSION_ISOLATION_OK' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "isolation.log")
if ($LASTEXITCODE -ne 0) { throw "session isolation acceptance failed with exit code $LASTEXITCODE" }

& $ZapVM run @Common --id windows-accept-readonly --session-id acceptance-a --network off --workspace-read-only -- /bin/sh -c 'set -eu; if printf "unexpected-write\n" >.zapvm-readonly-probe; then echo "read-only workspace accepted a write" >&2; exit 1; fi; test ! -e .zapvm-readonly-probe; test "$(cat platform-acceptance)" = workspace-ok; echo WINDOWS_READONLY_OK' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "readonly.log")
if ($LASTEXITCODE -ne 0) { throw "read-only workspace acceptance failed with exit code $LASTEXITCODE" }

& $ZapVM run @Common --id windows-accept-unrestricted --session-id acceptance-a --network unrestricted -- /bin/sh -c 'set -eu; test -n "$(ip -4 -o addr show scope global)"; ip route | grep -q "^default "; curl -fsS --max-time 20 https://example.com | grep -q "Example Domain"; echo WINDOWS_HCN_UNRESTRICTED_OK' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "unrestricted.log")
if ($LASTEXITCODE -ne 0) { throw "HCN unrestricted acceptance failed with exit code $LASTEXITCODE" }

$InboundReady = Join-Path $Workspace "hcn-inbound-ready"
$InboundIP = Join-Path $Workspace "hcn-inbound-ip"
$InboundPayload = Join-Path $Workspace "hcn-inbound-payload"
foreach ($marker in @($InboundReady, $InboundIP, $InboundPayload)) {
    if (Test-Path -LiteralPath $marker) { throw "Refusing pre-existing HCN inbound marker: $marker" }
}
$InboundProbe = $null
try {
    $InboundScript = 'set -eu; guest_ip=$(ip -4 -o addr show scope global | awk ''NR == 1 { split($4, value, "/"); print value[1] }''); test -n "$guest_ip"; timeout 12 /bin/busybox nc -l -p 23456 >hcn-inbound-payload 2>/dev/null & listener=$!; sleep 1; printf "%s\n" "$guest_ip" >hcn-inbound-ip; printf "ready\n" >hcn-inbound-ready; if wait "$listener"; then echo "unsolicited Host inbound connection reached guest" >&2; exit 1; fi; test ! -s hcn-inbound-payload; curl -fsS --max-time 20 https://example.com | grep -q "Example Domain"; echo WINDOWS_HCN_INBOUND_DENY_OK'
    $InboundArguments = @("run") + $Common + @(
        "--id", "windows-accept-inbound-deny", "--session-id", "acceptance-a",
        "--network", "unrestricted", "--exec-timeout", "2m", "--", "/bin/sh", "-c", $InboundScript
    )
    $InboundProbe = Start-CapturedZapVM -Arguments $InboundArguments `
        -StdoutPath (Join-Path $EvidenceDirectory "inbound-deny.stdout") `
        -StderrPath (Join-Path $EvidenceDirectory "inbound-deny.stderr")
    $MarkerReady = $false
    foreach ($attempt in 1..600) {
        if ($InboundProbe.Process.HasExited) {
            Complete-CapturedZapVM -Capture $InboundProbe -AllowFailure
            throw "HCN inbound probe exited before publishing its guest address"
        }
        if ((Test-Path -LiteralPath $InboundReady -PathType Leaf) -and
            (Test-Path -LiteralPath $InboundIP -PathType Leaf)) {
            $MarkerReady = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $MarkerReady) { throw "HCN inbound probe marker timeout" }
    $GuestIP = (Get-Content -Raw -LiteralPath $InboundIP).Trim()
    $ParsedGuestIP = $null
    if (-not [Net.IPAddress]::TryParse($GuestIP, [ref]$ParsedGuestIP) -or
        $ParsedGuestIP.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "Guest published an invalid IPv4 address: $GuestIP"
    }
    $Client = [Net.Sockets.TcpClient]::new()
    try {
        $Connect = $Client.ConnectAsync($GuestIP, 23456)
        $Completed = $false
        try {
            $Completed = $Connect.Wait(3000)
        } catch [AggregateException] {
            # A fast connection-refused result is an expected deny outcome.
            $Completed = $true
        }
        if ($Completed -and $Client.Connected) {
            $Unexpected = [Text.Encoding]::ASCII.GetBytes("UNEXPECTED_INBOUND")
            $Client.GetStream().Write($Unexpected, 0, $Unexpected.Length)
            throw "Unsolicited Host TCP connection reached guest $GuestIP`:23456"
        }
    } finally {
        $Client.Dispose()
    }
    Complete-CapturedZapVM -Capture $InboundProbe
    if (-not (Select-String -Quiet -SimpleMatch "WINDOWS_HCN_INBOUND_DENY_OK" -LiteralPath $InboundProbe.StdoutPath)) {
        throw "HCN inbound deny probe did not preserve outbound NAT return traffic"
    }
} finally {
    Stop-CapturedZapVM -Capture $InboundProbe
}

& $ZapVM run @Common --id windows-accept-restricted --session-id acceptance-a --network restricted `
    --allow-domain example.com --allow-port 443 --egress-audit-json -- /bin/sh -c 'set -eu; curl -fsS --max-time 20 https://example.com >/dev/null; if curl -fsS --max-time 5 https://www.iana.org >/dev/null 2>&1; then exit 1; fi; echo WINDOWS_RESTRICTED_POLICY_OK' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "restricted.log")
if ($LASTEXITCODE -ne 0) { throw "restricted egress acceptance failed with exit code $LASTEXITCODE" }

& $ZapVM run @Common --id windows-accept-crash --session-id acceptance-a --network off `
    --heartbeat-interval 500ms --heartbeat-timeout 250ms --crash-agent-after 1s -- /bin/sh -c 'printf "crash-written\n" >/var/lib/zapvm/data/crash-marker; sync; sleep 30; echo UNEXPECTED_CRASH_COMPLETION' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "crash.log")
if ($LASTEXITCODE -eq 0) { throw "agent crash injection unexpectedly succeeded" }
if (Select-String -Quiet -SimpleMatch "UNEXPECTED_CRASH_COMPLETION" (Join-Path $EvidenceDirectory "crash.log")) { throw "workload continued after agent crash" }

& $ZapVM run @Common --id windows-accept-recover --session-id acceptance-a --network off -- /bin/sh -c 'set -eu; test "$(cat /var/lib/zapvm/data/crash-marker)" = crash-written; echo WINDOWS_CRASH_RECOVERY_OK' `
    2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "recovery.log")
if ($LASTEXITCODE -ne 0) { throw "crash recovery acceptance failed with exit code $LASTEXITCODE" }

& $ZapVM state inspect --disk $StateDisk 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "state-final.json")
if ($LASTEXITCODE -ne 0) { throw "state inspect failed with exit code $LASTEXITCODE" }
$metadata = Get-Content -Raw (Join-Path $EvidenceDirectory "state-final.json") | ConvertFrom-Json
if (-not $metadata.clean_shutdown) { throw "final state metadata is not clean" }
& $DaemonAcceptance -ZapVM $ZapVM -ImageRoot $ImageRoot -ImagePublicKey $ImagePublicKey `
    -Workspace $Workspace -EvidenceDirectory (Join-Path $EvidenceDirectory "daemon")
Write-Host "WINDOWS_ACCEPTANCE_OK evidence=$EvidenceDirectory"
} finally {
    if ($ServiceInstalled) {
        & $ZapVM service uninstall 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "service-uninstall.log")
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "zapvm service uninstall failed with exit code $LASTEXITCODE; manual cleanup is required"
        }
    }
}
