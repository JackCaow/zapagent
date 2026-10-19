param(
    [Parameter(Mandatory = $true)][string]$ZapVM,
    [Parameter(Mandatory = $true)][string]$ImageRoot,
    [Parameter(Mandatory = $true)][string]$ImagePublicKey,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
    [ValidateRange(30, 300)][int]$WakeSeconds = 45
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
if (Test-Path -LiteralPath $EvidenceDirectory) { throw "Refusing existing evidence directory: $EvidenceDirectory" }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Windows Host power acceptance requires an elevated Administrator session"
}
if ($null -ne (Get-Service -Name "zapvm" -ErrorAction SilentlyContinue)) {
    throw "Refusing to modify a pre-existing zapvm service"
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ZapVMPowerAcceptance {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle CreateWaitableTimer(IntPtr attributes, bool manualReset, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetWaitableTimer(
        SafeWaitHandle timer, ref long dueTime, int period, IntPtr completionRoutine,
        IntPtr argument, bool resume);

    [DllImport("powrprof.dll", SetLastError = true)]
    private static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);

    [DllImport("powrprof.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsPwrSuspendAllowed();

    public static SafeWaitHandle ScheduleWake(int seconds) {
        SafeWaitHandle timer = CreateWaitableTimer(IntPtr.Zero, true, null);
        if (timer == null || timer.IsInvalid) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateWaitableTimer failed");
        }
        long dueTime = -checked((long)seconds * 10000000L);
        if (!SetWaitableTimer(timer, ref dueTime, 0, IntPtr.Zero, IntPtr.Zero, true)) {
            int error = Marshal.GetLastWin32Error();
            timer.Dispose();
            throw new Win32Exception(error, "SetWaitableTimer failed");
        }
        return timer;
    }

    public static void Suspend() {
        if (!SetSuspendState(false, false, false)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetSuspendState failed");
        }
    }
}
'@
if (-not [ZapVMPowerAcceptance]::IsPwrSuspendAllowed()) {
    throw "Windows reports that system suspend is not allowed"
}

New-Item -ItemType Directory -Path (Join-Path $EvidenceDirectory "state") -Force | Out-Null
$Endpoint = "\\.\pipe\zapvm-power-$PID-$([Guid]::NewGuid().ToString('N'))"
$StateRoot = Join-Path $EvidenceDirectory "state"
$DaemonStdout = Join-Path $EvidenceDirectory "daemon.stdout"
$DaemonStderr = Join-Path $EvidenceDirectory "daemon.stderr"
$ActiveStdout = Join-Path $EvidenceDirectory "active.stdout"
$ActiveStderr = Join-Path $EvidenceDirectory "active.stderr"
$ActiveStarted = Join-Path $Workspace "power-active-started"
$HostResumed = Join-Path $Workspace "power-host-resumed"
foreach ($marker in @($ActiveStarted, $HostResumed)) {
    if (Test-Path -LiteralPath $marker) { throw "Refusing pre-existing Host power marker: $marker" }
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

$ServiceInstalled = $false
$Daemon = $null
$ActiveClient = $null
$WakeTimer = $null
try {
    & $ZapVM service install | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "service-install.log")
    if ($LASTEXITCODE -ne 0) { throw "zapvm service install failed" }
    $ServiceInstalled = $true
    & $ZapVM doctor | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "doctor.log")
    if ($LASTEXITCODE -ne 0) { throw "zapvm doctor failed" }
    powercfg /a | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "power-capabilities.log")

    $Daemon = Start-CapturedProcess -Arguments @(
        "daemon", "serve", "--endpoint", $Endpoint,
        "--image-root", $ImageRoot, "--image-public-key", $ImagePublicKey,
        "--state-root", $StateRoot, "--max-workers", "1", "--max-per-workspace", "1",
        "--idle-timeout", "30m", "--stop-timeout", "45s", "--cpus", "2", "--memory-mib", "1024"
    ) -StdoutPath $DaemonStdout -StderrPath $DaemonStderr

    $Ready = $false
    foreach ($attempt in 1..300) {
        if ($Daemon.Process.HasExited) {
            Complete-CapturedProcess -Capture $Daemon -AllowFailure
            throw "Daemon exited before readiness; stderr=$DaemonStderr"
        }
        $InitialStatusJSON = & $ZapVM daemon status --endpoint $Endpoint 2>$null
        if ($LASTEXITCODE -eq 0) { $Ready = $true; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $Ready) { throw "Daemon did not become ready" }
    $InitialStatusJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-initial.json")

    $BeforeScript = 'set -eu; cat /proc/sys/kernel/random/boot_id; printf "%s\n" POWER_STATE_MARKER >/var/lib/zapvm/data/power-marker; printf "%s\n" POWER_SESSION_MARKER >"$HOME/power-marker"; echo POWER_BEFORE_SLEEP_OK'
    $Before = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace `
        --session-id host-power --exec-timeout 2m -- /bin/sh -c $BeforeScript
    if ($LASTEXITCODE -ne 0 -or -not ($Before -contains "POWER_BEFORE_SLEEP_OK")) {
        throw "Initial Host power daemon exec failed"
    }
    $Before | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "exec-before-sleep.log")
    $GuestBootBefore = @($Before)[0].Trim()

    $ActiveScript = 'set -eu; printf "%s\n" ready >power-active-started; while [ ! -f power-host-resumed ]; do sleep 0.2; done; echo POWER_ACTIVE_RESUMED_OK'
    $ActiveClient = Start-CapturedProcess -Arguments @(
        "daemon", "exec", "--endpoint", $Endpoint, "--workspace", $Workspace,
        "--session-id", "host-power", "--exec-timeout", "10m", "--", "/bin/sh", "-c", $ActiveScript
    ) -StdoutPath $ActiveStdout -StderrPath $ActiveStderr
    $MarkerReady = $false
    foreach ($attempt in 1..300) {
        if ($ActiveClient.Process.HasExited) {
            Complete-CapturedProcess -Capture $ActiveClient -AllowFailure
            throw "Active command exited before Host sleep"
        }
        if (Test-Path -LiteralPath $ActiveStarted -PathType Leaf) { $MarkerReady = $true; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $MarkerReady) { throw "Active command marker timeout" }
    $ActiveStatusJSON = & $ZapVM daemon status --endpoint $Endpoint
    $ActiveStatusJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-active-before-sleep.json")
    $ActiveStatus = $ActiveStatusJSON | Out-String | ConvertFrom-Json
    if ($ActiveStatus.leases -ne 1) { throw "Expected one active lease before Host sleep" }

    $HostBootBefore = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")
    $HostBootBefore | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "host-boot-before.txt")
    $SleepStarted = [DateTime]::UtcNow
    $SleepStarted.ToString("o") | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "sleep-start.txt")
    $WakeTimer = [ZapVMPowerAcceptance]::ScheduleWake($WakeSeconds)
    [ZapVMPowerAcceptance]::Suspend()
    $SleepFinished = [DateTime]::UtcNow
    $SleepFinished.ToString("o") | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "sleep-finish.txt")
    $ElapsedSeconds = [int]($SleepFinished - $SleepStarted).TotalSeconds
    if ($ElapsedSeconds -lt 5) { throw "Host suspend returned too quickly (${ElapsedSeconds}s)" }

    $Resumed = $false
    foreach ($attempt in 1..600) {
        if ($Daemon.Process.HasExited) {
            Complete-CapturedProcess -Capture $Daemon -AllowFailure
            throw "Daemon exited during Host power transition"
        }
        $AfterWakeStatusJSON = & $ZapVM daemon status --endpoint $Endpoint 2>$null
        if ($LASTEXITCODE -eq 0) {
            $AfterWakeStatus = $AfterWakeStatusJSON | Out-String | ConvertFrom-Json
            if (-not $AfterWakeStatus.paused -and $AfterWakeStatus.leases -eq 1) {
                $Resumed = $true
                break
            }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $Resumed) { throw "Daemon did not resume its active lease" }
    $AfterWakeStatusJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "status-after-wake.json")
    $HostBootAfter = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")
    $HostBootAfter | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "host-boot-after.txt")
    if ($HostBootAfter -ne $HostBootBefore) { throw "Host rebooted instead of resuming" }

    [IO.File]::WriteAllText($HostResumed, "resumed`n", [Text.UTF8Encoding]::new($false))
    Complete-CapturedProcess -Capture $ActiveClient
    if (-not (Select-String -Quiet -SimpleMatch "POWER_ACTIVE_RESUMED_OK" -LiteralPath $ActiveStdout)) {
        throw "Active command did not continue after Host wake"
    }

    $AfterScript = 'set -eu; cat /proc/sys/kernel/random/boot_id; test "$(cat /var/lib/zapvm/data/power-marker)" = POWER_STATE_MARKER; test "$(cat "$HOME/power-marker")" = POWER_SESSION_MARKER; echo POWER_AFTER_WAKE_OK'
    $After = & $ZapVM daemon exec --endpoint $Endpoint --workspace $Workspace `
        --session-id host-power --exec-timeout 2m -- /bin/sh -c $AfterScript
    if ($LASTEXITCODE -ne 0 -or -not ($After -contains "POWER_AFTER_WAKE_OK")) {
        throw "Post-wake daemon exec failed"
    }
    $After | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "exec-after-wake.log")
    $GuestBootAfter = @($After)[0].Trim()
    if ($GuestBootAfter -ne $GuestBootBefore) { throw "Guest rebooted across Host sleep" }

    Get-WinEvent -FilterHashtable @{ LogName = "System"; StartTime = $SleepStarted.AddMinutes(-1) } -ErrorAction SilentlyContinue |
        Where-Object { $_.ProviderName -in @("Microsoft-Windows-Kernel-Power", "Microsoft-Windows-Power-Troubleshooter") } |
        Select-Object TimeCreated, ProviderName, Id, LevelDisplayName, Message |
        Format-List | Out-File -LiteralPath (Join-Path $EvidenceDirectory "host-power.log") -Encoding utf8

    & $ZapVM daemon stop --endpoint $Endpoint
    if ($LASTEXITCODE -ne 0) { throw "Daemon stop failed" }
    Complete-CapturedProcess -Capture $Daemon
    if (-not (Select-String -Quiet -SimpleMatch "zapVM daemon Host suspend completed ownership=true" -LiteralPath $DaemonStderr) -or
        -not (Select-String -Quiet -SimpleMatch "zapVM daemon Host resume completed" -LiteralPath $DaemonStderr)) {
        throw "Daemon log does not prove automatic Host suspend/resume callbacks"
    }

    $StateFiles = @(Get-ChildItem -LiteralPath $StateRoot -Filter "*.vhdx" -File)
    if ($StateFiles.Count -lt 1) { throw "No daemon state disk was created" }
    foreach ($StateFile in $StateFiles) {
        $StateJSON = & $ZapVM state inspect --disk $StateFile.FullName
        if ($LASTEXITCODE -ne 0) { throw "State inspect failed for $($StateFile.FullName)" }
        $StateJSON | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "state-$($StateFile.BaseName).json")
        $State = $StateJSON | Out-String | ConvertFrom-Json
        if (-not $State.clean_shutdown) { throw "State is not clean: $($StateFile.FullName)" }
    }
    $Residual = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq "zapvm.exe" -and $null -ne $_.CommandLine -and $_.CommandLine.Contains($EvidenceDirectory)
    })
    if ($Residual.Count -ne 0) { throw "Host power acceptance left zapvm processes: $($Residual.ProcessId -join ',')" }
    [PSCustomObject]@{
        schema_version = 1
        platform = "Windows"
        host_suspend_elapsed_seconds = $ElapsedSeconds
        guest_boot_id = $GuestBootBefore
        active_command_resumed = $true
        state_and_session_preserved = $true
        clean_shutdown = $true
        state_count = $StateFiles.Count
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "assertions.json")
    Write-Host "HOST_POWER_ACCEPTANCE_OK platform=Windows evidence=$EvidenceDirectory"
} finally {
    if ($null -ne $WakeTimer) { $WakeTimer.Dispose() }
    Stop-CapturedProcess -Capture $ActiveClient
    if ($null -ne $Daemon -and -not $Daemon.Completed) {
        if (-not $Daemon.Process.HasExited) {
            & $ZapVM daemon stop --endpoint $Endpoint 2>$null | Out-Null
            if (-not $Daemon.Process.WaitForExit(15000)) {
                try { $Daemon.Process.Kill($true) } catch { Write-Warning $_ }
            }
        }
        Complete-CapturedProcess -Capture $Daemon -AllowFailure
    }
    if ($ServiceInstalled) {
        & $ZapVM service uninstall 2>$null | Out-Null
    }
}
