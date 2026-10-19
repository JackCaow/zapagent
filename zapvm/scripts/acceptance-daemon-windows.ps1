param(
    [Parameter(Mandatory = $true)][string]$ZapVM,
    [Parameter(Mandatory = $true)][string]$ImageRoot,
    [Parameter(Mandatory = $true)][string]$ImagePublicKey,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

$ErrorActionPreference = "Stop"
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)) {
    $PSNativeCommandUseErrorActionPreference = $false
}
foreach ($name in @("ZapVM", "ImageRoot", "ImagePublicKey", "Workspace", "EvidenceDirectory")) {
    $value = Get-Variable -Name $name -ValueOnly
    if (-not [IO.Path]::IsPathFullyQualified($value)) { throw "$name must be an absolute path: $value" }
}
if (-not (Test-Path -LiteralPath $ZapVM -PathType Leaf)) { throw "Missing zapvm executable: $ZapVM" }
if (-not (Test-Path -LiteralPath $ImageRoot -PathType Container)) { throw "Missing image root: $ImageRoot" }
if (-not (Test-Path -LiteralPath $ImagePublicKey -PathType Leaf)) { throw "Missing image public key: $ImagePublicKey" }
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Missing workspace: $Workspace" }
if (Test-Path -LiteralPath $EvidenceDirectory) { throw "Refusing existing daemon evidence directory: $EvidenceDirectory" }

$StateRoot = Join-Path $EvidenceDirectory "state"
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
$Endpoint = "\\.\pipe\zapvm-acceptance-$PID-$([Guid]::NewGuid().ToString('N'))"
$Credential = Join-Path $EvidenceDirectory "acceptance-token"
[IO.File]::WriteAllText($Credential, "zapvm-target-host-acceptance-token`n", [Text.UTF8Encoding]::new($false))
$DaemonStdout = Join-Path $EvidenceDirectory "daemon.stdout"
$DaemonStderr = Join-Path $EvidenceDirectory "daemon.stderr"
$ActiveReleaseName = ".zapvm-acceptance-active-release-$PID"
$ActiveRelease = Join-Path $Workspace $ActiveReleaseName
$RouteReleaseName = ".zapvm-acceptance-route-release-$PID"
$RouteRelease = Join-Path $Workspace $RouteReleaseName
foreach ($release in @($ActiveRelease, $RouteRelease)) {
    if (Test-Path -LiteralPath $release) { throw "Release marker already exists: $release" }
}

function Start-CapturedProcess {
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

function Complete-CapturedProcess {
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

function Stop-CapturedProcess {
    param($Capture)
    if ($null -eq $Capture -or $Capture.Completed) { return }
    if (-not $Capture.Process.HasExited) {
        try { $Capture.Process.Kill($true) } catch { Write-Warning $_ }
    }
    Complete-CapturedProcess -Capture $Capture -AllowFailure
}

$Daemon = $null
$ActiveClient = $null
$PauseClient = $null
$RouteRW = $null
$RouteRO = $null
try {
    $Daemon = Start-CapturedProcess -Arguments @(
        "daemon", "serve",
        "--endpoint", $Endpoint,
        "--image-root", $ImageRoot,
        "--image-public-key", $ImagePublicKey,
        "--state-root", $StateRoot,
        "--credential", "acceptance-token=$Credential",
        "--max-workers", "2",
        "--max-per-workspace", "2",
        "--idle-timeout", "30m",
        "--stop-timeout", "45s",
        "--cpus", "2",
        "--memory-mib", "1024"
    ) -StdoutPath $DaemonStdout -StderrPath $DaemonStderr

    $Ready = $false
    foreach ($attempt in 1..300) {
        if ($Daemon.Process.HasExited) {
            Complete-CapturedProcess -Capture $Daemon -AllowFailure
            throw "Daemon exited before accepting status requests; stderr=$DaemonStderr"
        }
        $InitialStatusJSON = & $ZapVM daemon status --endpoint $Endpoint 2>$null
        if ($LASTEXITCODE -eq 0) { $Ready = $true; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $Ready) { throw "Daemon endpoint did not become ready" }
    $InitialStatusJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-initial.json")
    $InitialStatus = $InitialStatusJSON | Out-String | ConvertFrom-Json
    if ($InitialStatus.workers -ne 0) { throw "Cold daemon unexpectedly owns workers" }

    $BeforePauseScript = 'set -eu; cat /proc/sys/kernel/random/boot_id; test "$(cat /run/zapvm-credentials/acceptance-token)" = zapvm-target-host-acceptance-token; if printf x >>/run/zapvm-credentials/acceptance-token 2>/dev/null; then exit 1; fi; printf "%s\n" DAEMON_STATE_MARKER >/var/lib/zapvm/data/daemon-marker; printf "%s\n" DAEMON_SESSION_MARKER >"$HOME/daemon-marker"; echo DAEMON_CREDENTIAL_READONLY_OK'
    $BeforePause = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace `
        --session-id target-daemon --credential-id acceptance-token --exec-timeout 2m -- /bin/sh -c $BeforePauseScript
    if ($LASTEXITCODE -ne 0) { throw "Initial daemon exec failed with exit code $LASTEXITCODE" }
    $BeforePause | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "exec-before-pause.log")
    $BootBefore = @($BeforePause)[0].Trim()
    if ([string]::IsNullOrWhiteSpace($BootBefore) -or -not ($BeforePause -contains "DAEMON_CREDENTIAL_READONLY_OK")) {
        throw "Initial daemon exec output was incomplete"
    }

    $CredentialCleanupScript = 'set -eu; test ! -e /run/zapvm-credentials/acceptance-token; echo DAEMON_CREDENTIAL_CLEANUP_OK'
    $CredentialCleanup = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace `
        --session-id target-daemon --exec-timeout 2m -- /bin/sh -c $CredentialCleanupScript
    if ($LASTEXITCODE -ne 0 -or -not ($CredentialCleanup -contains "DAEMON_CREDENTIAL_CLEANUP_OK")) {
        throw "Request credential cleanup was not observed"
    }
    $CredentialCleanup | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "credential-cleanup.log")

    $GitControl = Join-Path $Workspace ".git"
    $ZapControl = Join-Path $Workspace ".zapcode"
    New-Item -ItemType Directory -Force -Path $GitControl, $ZapControl | Out-Null
    [IO.File]::WriteAllText((Join-Path $GitControl "protected"), "GIT_CONTROL_ORIGINAL`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $ZapControl "settings.json"), "ZAP_CONTROL_ORIGINAL`n", [Text.UTF8Encoding]::new($false))
    $ProtectedCommon = @(
        "daemon", "exec", "--endpoint", $Endpoint, "--workspace", $Workspace,
        "--session-id", "target-daemon", "--protect-workspace-path", ".git",
        "--protect-workspace-path", ".zapcode", "--exec-timeout", "2m", "--", "/bin/sh", "-c"
    )
    $AllowedWrite = & $ZapVM @ProtectedCommon 'printf "%s\n" WORKSPACE_WRITE_OK >ordinary-write'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $Workspace "ordinary-write"))) {
        throw "Ordinary workspace write failed while control paths were protected"
    }
    foreach ($ProtectedTarget in @(".git/protected", ".zapcode/settings.json")) {
        $ProtectedWrite = & $ZapVM @ProtectedCommon "printf '%s\n' TAMPERED >'$ProtectedTarget'" 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Protected workspace write unexpectedly succeeded: $ProtectedTarget" }
        $EvidenceName = $ProtectedTarget.Replace("/", "_").Replace(".", "_")
        $ProtectedWrite | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "protected-$EvidenceName.log")
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $GitControl "protected")).Trim() -ne "GIT_CONTROL_ORIGINAL") {
        throw ".git protected content changed"
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $ZapControl "settings.json")).Trim() -ne "ZAP_CONTROL_ORIGINAL") {
        throw ".zapcode protected content changed"
    }
    "PROTECTED_WORKSPACE_PATHS_OK" | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "protected-workspace-paths.log")

    $ActiveMarker = Join-Path $Workspace "daemon-active-started"
    if (Test-Path -LiteralPath $ActiveMarker) { throw "Active drain marker already exists: $ActiveMarker" }
    $ActiveScript = "set -eu; printf '%s\n' ready >daemon-active-started; while [ ! -e '$ActiveReleaseName' ]; do sleep 1; done; echo DAEMON_ACTIVE_DRAIN_OK"
    $ActiveClient = Start-CapturedProcess -Arguments @(
        "daemon", "exec", "--endpoint", $Endpoint, "--workspace", $Workspace,
        "--session-id", "target-daemon", "--exec-timeout", "2m", "--", "/bin/sh", "-c",
        $ActiveScript
    ) -StdoutPath (Join-Path $EvidenceDirectory "active-drain.log") -StderrPath (Join-Path $EvidenceDirectory "active-drain.stderr")
    $MarkerReady = $false
    foreach ($attempt in 1..300) {
        if ($ActiveClient.Process.HasExited) {
            Complete-CapturedProcess -Capture $ActiveClient -AllowFailure
            throw "Active command exited before publishing its marker"
        }
        if (Test-Path -LiteralPath $ActiveMarker -PathType Leaf) { $MarkerReady = $true; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $MarkerReady) { throw "Active drain marker timeout" }
    $ActiveStatusJSON = & $ZapVM daemon status --endpoint $Endpoint
    if ($LASTEXITCODE -ne 0) { throw "Active status request failed" }
    $ActiveStatusJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-active.json")
    $ActiveStatus = $ActiveStatusJSON | Out-String | ConvertFrom-Json
    if ($ActiveStatus.leases -ne 1) { throw "Expected one active lease" }
    $PauseTimer = [Diagnostics.Stopwatch]::StartNew()
    $PauseClient = Start-CapturedProcess -Arguments @(
        "daemon", "pause", "--endpoint", $Endpoint
    ) -StdoutPath (Join-Path $EvidenceDirectory "pause.log") -StderrPath (Join-Path $EvidenceDirectory "pause.stderr")
    Start-Sleep -Seconds 1
    if ($ActiveClient.Process.HasExited) {
        Complete-CapturedProcess -Capture $ActiveClient -AllowFailure
        throw "Active command exited before the host release marker"
    }
    if ($PauseClient.Process.HasExited) {
        Complete-CapturedProcess -Capture $PauseClient -AllowFailure
        throw "Daemon pause returned before the active command was released"
    }
    [IO.File]::WriteAllText($ActiveRelease, "release`n", [Text.UTF8Encoding]::new($false))
    Complete-CapturedProcess -Capture $ActiveClient
    Complete-CapturedProcess -Capture $PauseClient
    $PauseTimer.Stop()
    $PauseDrainMilliseconds = $PauseTimer.ElapsedMilliseconds
    $PauseDrainMilliseconds | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "pause-drain-milliseconds.txt")
    Remove-Item -LiteralPath $ActiveRelease -Force
    if (-not (Select-String -Quiet -SimpleMatch "DAEMON_ACTIVE_DRAIN_OK" -LiteralPath $ActiveClient.StdoutPath)) {
        throw "Active command did not complete before pause"
    }
    $PausedStatusJSON = & $ZapVM daemon status --endpoint $Endpoint
    $PausedStatusJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-paused.json")
    $PausedStatus = $PausedStatusJSON | Out-String | ConvertFrom-Json
    if (-not $PausedStatus.paused -or $PausedStatus.leases -ne 0) { throw "Daemon did not enter drained paused state" }
    $PausedExec = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace -- /bin/true 2>&1
    if ($LASTEXITCODE -eq 0 -or -not (($PausedExec | Out-String).Contains("VM pool is paused"))) {
        throw "Paused daemon did not reject a new exec"
    }
    $PausedExec | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "paused-exec.log")
    & $ZapVM daemon resume --endpoint $Endpoint
    if ($LASTEXITCODE -ne 0) { throw "Daemon resume failed" }

    $AfterResumeScript = 'set -eu; cat /proc/sys/kernel/random/boot_id; test "$(cat /var/lib/zapvm/data/daemon-marker)" = DAEMON_STATE_MARKER; test "$(cat "$HOME/daemon-marker")" = DAEMON_SESSION_MARKER; echo DAEMON_RESUME_PRESERVED_OK'
    $AfterResume = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace `
        --session-id target-daemon --exec-timeout 2m -- /bin/sh -c $AfterResumeScript
    if ($LASTEXITCODE -ne 0) { throw "Post-resume daemon exec failed" }
    $AfterResume | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "exec-after-resume.log")
    $BootAfter = @($AfterResume)[0].Trim()
    if ($BootAfter -ne $BootBefore -or -not ($AfterResume -contains "DAEMON_RESUME_PRESERVED_OK")) {
        throw "Pause/resume did not preserve VM and Session state"
    }

    # Hold both leases until the host has observed them and proved that a third
    # route is rejected. A file handshake avoids assuming any HCS boot time.
    $RouteWaitScript = "while [ ! -e '$RouteReleaseName' ]; do sleep 1; done"
    $RouteRW = Start-CapturedProcess -Arguments @(
        "daemon", "exec", "--endpoint", $Endpoint, "--workspace", $Workspace,
        "--session-id", "route-rw", "--exec-timeout", "5m", "--", "/bin/sh", "-c", "$RouteWaitScript; echo DAEMON_ROUTE_RW_OK"
    ) -StdoutPath (Join-Path $EvidenceDirectory "route-rw.log") -StderrPath (Join-Path $EvidenceDirectory "route-rw.stderr")
    $RouteRO = Start-CapturedProcess -Arguments @(
        "daemon", "exec", "--endpoint", $Endpoint, "--workspace", $Workspace, "--workspace-read-only",
        "--session-id", "route-ro", "--exec-timeout", "5m", "--", "/bin/sh", "-c", "$RouteWaitScript; echo DAEMON_ROUTE_RO_OK"
    ) -StdoutPath (Join-Path $EvidenceDirectory "route-ro.log") -StderrPath (Join-Path $EvidenceDirectory "route-ro.stderr")
    $TwoRoutesObserved = $false
    $TwoRouteTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($TwoRouteTimer.Elapsed -lt [TimeSpan]::FromMinutes(3)) {
        foreach ($capture in @($RouteRW, $RouteRO)) {
            if ($capture.Process.HasExited) {
                Complete-CapturedProcess -Capture $capture -AllowFailure
                throw "Concurrent route exited before both leases were observed; stderr=$($capture.StderrPath)"
            }
        }
        $TwoRouteJSON = & $ZapVM daemon status --endpoint $Endpoint
        if ($LASTEXITCODE -eq 0) {
            $TwoRouteStatus = $TwoRouteJSON | Out-String | ConvertFrom-Json
            if ($TwoRouteStatus.workers -eq 2 -and $TwoRouteStatus.leases -eq 2) {
                $TwoRoutesObserved = $true
                $TwoRouteJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-two-routes.json")
                break
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $TwoRoutesObserved) { throw "Two active routes were not observed" }
    $Quota = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace --network restricted `
        --allow-domain example.com --allow-port 443 -- /bin/true 2>&1
    if ($LASTEXITCODE -eq 0 -or -not (($Quota | Out-String).Contains("VM pool quota is exhausted"))) {
        throw "Third active route unexpectedly bypassed quota"
    }
    $Quota | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "quota.log")
    [IO.File]::WriteAllText($RouteRelease, "release`n", [Text.UTF8Encoding]::new($false))
    Complete-CapturedProcess -Capture $RouteRW
    Complete-CapturedProcess -Capture $RouteRO
    Remove-Item -LiteralPath $RouteRelease -Force
    foreach ($capture in @($RouteRW, $RouteRO)) {
        if (-not (Select-String -Quiet -SimpleMatch "DAEMON_ROUTE_" -LiteralPath $capture.StdoutPath)) {
            throw "A concurrent route did not complete"
        }
    }

    $Restricted = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace --network restricted `
        --allow-domain example.com --allow-port 443 --session-id route-restricted --exec-timeout 2m -- `
        /bin/sh -c 'echo DAEMON_LRU_RESTRICTED_OK'
    if ($LASTEXITCODE -ne 0 -or -not ($Restricted -contains "DAEMON_LRU_RESTRICTED_OK")) {
        throw "Idle LRU route replacement failed"
    }
    $Restricted | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "route-restricted.log")
    $AfterLRUJSON = & $ZapVM daemon status --endpoint $Endpoint
    $AfterLRUJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-after-lru.json")
    $AfterLRU = $AfterLRUJSON | Out-String | ConvertFrom-Json
    if ($AfterLRU.workers -ne 2) { throw "LRU replacement changed the worker quota" }

    & $ZapVM daemon pause --endpoint $Endpoint
    if ($LASTEXITCODE -ne 0) { throw "Final daemon pause failed" }
    & $ZapVM daemon stop --endpoint $Endpoint
    if ($LASTEXITCODE -ne 0) { throw "Paused daemon stop failed" }
    Complete-CapturedProcess -Capture $Daemon
    if (-not (Select-String -Quiet -SimpleMatch "guest state flush acknowledged" -LiteralPath $DaemonStderr)) {
        throw "Daemon log does not contain guest state flush acknowledgement"
    }

    $StateFiles = @(Get-ChildItem -LiteralPath $StateRoot -Filter "*.vhdx" -File)
    if ($StateFiles.Count -lt 3) { throw "Expected at least three route state disks, got $($StateFiles.Count)" }
    foreach ($StateFile in $StateFiles) {
        $StateJSON = & $ZapVM state inspect --disk $StateFile.FullName
        if ($LASTEXITCODE -ne 0) { throw "State inspect failed for $($StateFile.FullName)" }
        $StatePath = Join-Path $EvidenceDirectory "state-$($StateFile.BaseName).json"
        $StateJSON | Set-Content -LiteralPath $StatePath
        $State = $StateJSON | Out-String | ConvertFrom-Json
        if (-not $State.clean_shutdown) { throw "Route state is not clean: $($StateFile.FullName)" }
    }
    $Residual = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq "zapvm.exe" -and $null -ne $_.CommandLine -and $_.CommandLine.Contains($EvidenceDirectory)
    })
    if ($Residual.Count -ne 0) { throw "Daemon acceptance left zapvm processes: $($Residual.ProcessId -join ',')" }
    Remove-Item -LiteralPath $Credential -Force
    [PSCustomObject]@{
        schema_version = 1
        boot_id = $BootBefore
        pause_drain_milliseconds = $PauseDrainMilliseconds
        state_count = $StateFiles.Count
        credential_cleanup = $true
        quota_rejection = $true
        lru_replacement = $true
        clean_shutdown = $true
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "assertions.json")
    Write-Host "WINDOWS_DAEMON_ACCEPTANCE_OK evidence=$EvidenceDirectory"
} finally {
    Remove-Item -LiteralPath $ActiveRelease, $RouteRelease -Force -ErrorAction SilentlyContinue
    foreach ($capture in @($ActiveClient, $PauseClient, $RouteRW, $RouteRO)) {
        Stop-CapturedProcess -Capture $capture
    }
    if ($null -ne $Daemon -and -not $Daemon.Completed) {
        if (-not $Daemon.Process.HasExited) {
            & $ZapVM daemon stop --endpoint $Endpoint 2>$null | Out-Null
            if (-not $Daemon.Process.WaitForExit(15000)) {
                try { $Daemon.Process.Kill($true) } catch { Write-Warning $_ }
            }
        }
        Complete-CapturedProcess -Capture $Daemon -AllowFailure
    }
}
