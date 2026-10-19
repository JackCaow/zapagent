param(
    [ValidateSet("windows-power", "windows-acl-recovery")]
    [string]$Target = "windows-power"
)

$ErrorActionPreference = "Stop"
$Failures = [Collections.Generic.List[string]]::new()

function Pass-Capability([string]$Name, [string]$Detail) {
    Write-Host ("pass  {0,-32} {1}" -f $Name, $Detail)
}

function Fail-Capability([string]$Name, [string]$Detail) {
    Write-Host ("fail  {0,-32} {1}" -f $Name, $Detail)
    $Failures.Add("${Name}: ${Detail}")
}

Write-Host "target=$Target"
Write-Host "platform=$([Environment]::OSVersion.VersionString)"
Write-Host "architecture=$env:PROCESSOR_ARCHITECTURE"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Pass-Capability "administrator" $identity.Name
} else {
    Fail-Capability "administrator" "the self-hosted runner process must be elevated"
}

if ($env:PROCESSOR_ARCHITECTURE -eq "AMD64") {
    Pass-Capability "host-architecture" "AMD64"
} else {
    Fail-Capability "host-architecture" "want AMD64, got $env:PROCESSOR_ARCHITECTURE"
}

$build = [Environment]::OSVersion.Version.Build
if ($build -ge 20348) {
    Pass-Capability "windows-build" "$build"
} else {
    Fail-Capability "windows-build" "want 20348+, got $build"
}

$computer = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
if ($null -ne $computer -and $computer.HypervisorPresent) {
    Pass-Capability "hypervisor" "present"
} else {
    Fail-Capability "hypervisor" "Win32_ComputerSystem.HypervisorPresent is false"
}

$hyperVState = "Unavailable"
try {
    $hyperVState = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State.ToString()
} catch {
    Fail-Capability "hyper-v-feature" $_.Exception.Message
}
if ($hyperVState -eq "Enabled") {
    Pass-Capability "hyper-v-feature" $hyperVState
} elseif (-not ($Failures | Where-Object { $_ -like "hyper-v-feature:*" })) {
    Fail-Capability "hyper-v-feature" "want Enabled, got $hyperVState"
}

foreach ($serviceName in @("vmcompute", "hns", "vfpext")) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -ne $service -and $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
        Pass-Capability "service-$serviceName" "Running"
    } else {
        $state = if ($null -eq $service) { "Absent" } else { $service.Status.ToString() }
        Fail-Capability "service-$serviceName" "want Running, got $state"
    }
}

foreach ($library in @("computecore.dll", "computenetwork.dll", "vmcompute.dll")) {
    $path = Join-Path $env:SystemRoot "System32\$library"
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Pass-Capability "library-$library" $path
    } else {
        Fail-Capability "library-$library" "missing $path"
    }
}

if ($null -eq (Get-Service -Name "zapvm" -ErrorAction SilentlyContinue)) {
    Pass-Capability "clean-zapvm-service" "no pre-existing service"
} else {
    Fail-Capability "clean-zapvm-service" "remove the pre-existing zapvm service before acceptance"
}

if ($Target -eq "windows-power" -and $null -eq ("ZapVMSelfHostedPowerPreflight" -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class ZapVMSelfHostedPowerPreflight {
    [DllImport("powrprof.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsPwrSuspendAllowed();
}
'@
}
if ($Target -eq "windows-power") {
    if ([ZapVMSelfHostedPowerPreflight]::IsPwrSuspendAllowed()) {
        Pass-Capability "system-suspend" "allowed"
    } else {
        Fail-Capability "system-suspend" "Windows reports that suspend is unavailable"
    }

    $powercfg = & powercfg.exe /a 2>&1
    if ($LASTEXITCODE -eq 0) {
        Pass-Capability "powercfg" (($powercfg | Out-String).Trim() -replace "\s+", " ")
    } else {
        Fail-Capability "powercfg" "powercfg /a exited with $LASTEXITCODE"
    }
}

$workspace = if ([string]::IsNullOrWhiteSpace($env:RUNNER_WORKSPACE)) { $PWD.Path } else { $env:RUNNER_WORKSPACE }
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($workspace)).TrimEnd('\').TrimEnd(':')) -ErrorAction SilentlyContinue
if ($null -ne $drive -and $drive.Free -ge 10GB) {
    Pass-Capability "free-space" ("{0:N2} GiB" -f ($drive.Free / 1GB))
} else {
    $available = if ($null -eq $drive) { "unavailable" } else { "{0:N2} GiB" -f ($drive.Free / 1GB) }
    Fail-Capability "free-space" "need at least 10 GiB, got $available"
}

if ($Failures.Count -ne 0) {
    throw "SELF_HOSTED_PREFLIGHT_FAILED target=$Target failures=$($Failures -join '; ')"
}
Write-Host "SELF_HOSTED_PREFLIGHT_OK target=$Target"
