[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ImageRoot,
    [Parameter(Mandatory = $true)][string]$ImagePublicKey,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
    [int]$ControlPort = 19444,
    [string]$GoCommand = "go",
    [string]$OpenSSLCommand = "openssl"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-Exit([string]$Label) {
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Invoke-Logged([string]$Path, [string[]]$Arguments, [string]$Log) {
    & $Path @Arguments *>&1 | Tee-Object -FilePath $Log
    Assert-Exit $Path
}

function Wait-NodeVersion([string]$StatePath, [string]$Version) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $StatePath) {
            $text = Get-Content -LiteralPath $StatePath -Raw
            if ($text.Contains('"node_version":"' + $Version + '"') -and $text.Contains('"daemon_state":"healthy"')) { return }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Node did not register healthy version $Version."
}

function Protect-Tree([string]$Path) {
    & icacls.exe $Path "/inheritance:r" "/grant:r" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
    Assert-Exit "icacls"
    & icacls.exe $Path "/setowner" "*S-1-5-32-544" "/T" "/C" | Out-Null
    Assert-Exit "icacls owner"
}

function Build-Release([string]$Version, [string]$Output, [Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    New-Item -ItemType Directory -Path $Output | Out-Null
    & $GoCommand build -trimpath -ldflags "-X main.version=$Version" -o (Join-Path $Output "zapvm.exe") ./cmd/zapvm
    Assert-Exit "build zapvm $Version"
    & $GoCommand build -trimpath -ldflags "-X main.version=$Version" -o (Join-Path $Output "zapvm-node.exe") ./cmd/zapvm-node
    Assert-Exit "build zapvm-node $Version"
    foreach ($name in @("zapvm.exe", "zapvm-node.exe")) {
        $signature = Set-AuthenticodeSignature -FilePath (Join-Path $Output $name) -Certificate $Certificate -HashAlgorithm SHA256
        if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
            throw "Signing $name produced status $($signature.Status)."
        }
    }
}

function Write-OpenSSLFile([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Write-JSONFile([string]$Path, [object]$Value, [int]$Depth) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth $Depth), [Text.UTF8Encoding]::new($false))
}

function Issue-TLSCertificate([string]$Fixture, [string]$Name, [string]$URI, [string]$Usage) {
    $requestConfig = Join-Path $Fixture "$Name.cnf"
    $extensionConfig = Join-Path $Fixture "$Name-ext.cnf"
    Write-OpenSSLFile $requestConfig @"
[req]
distinguished_name = dn
req_extensions = identity
prompt = no
[dn]
CN = $Name
[identity]
subjectAltName = URI:$URI
keyUsage = critical,digitalSignature
extendedKeyUsage = $Usage
"@
    Write-OpenSSLFile $extensionConfig @"
subjectAltName = URI:$URI
keyUsage = critical,digitalSignature
extendedKeyUsage = $Usage
"@
    & $OpenSSLCommand req -newkey rsa:2048 -nodes -config $requestConfig -keyout (Join-Path $Fixture "$Name.key") -out (Join-Path $Fixture "$Name.csr") | Out-Null
    Assert-Exit "openssl request $Name"
    $serialArguments = if (Test-Path -LiteralPath (Join-Path $Fixture "ca.srl")) { @("-CAserial", (Join-Path $Fixture "ca.srl")) } else { @("-CAcreateserial") }
    & $OpenSSLCommand x509 -req -days 1 -in (Join-Path $Fixture "$Name.csr") -CA (Join-Path $Fixture "ca.pem") -CAkey (Join-Path $Fixture "ca.key") @serialArguments -extfile $extensionConfig -out (Join-Path $Fixture "$Name.pem") | Out-Null
    Assert-Exit "openssl issue $Name"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run from elevated Administrator PowerShell." }
if ([Environment]::OSVersion.Version.Build -lt 20348) { throw "Windows build 20348+ is required." }
if ($ControlPort -lt 1024 -or $ControlPort -gt 65535) { throw "ControlPort is invalid." }
foreach ($command in @($GoCommand, $OpenSSLCommand, "icacls.exe")) {
    if ($null -eq (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command $command is unavailable." }
}
foreach ($service in @("zapvm", "zapvm-daemon", "zapvm-node")) {
    if ($null -ne (Get-Service -Name $service -ErrorAction SilentlyContinue)) { throw "Refusing to replace pre-existing service $service." }
}
foreach ($path in @($ImageRoot, $ImagePublicKey, $EvidenceDirectory)) {
    if (-not [IO.Path]::IsPathFullyQualified($path)) { throw "All paths must be absolute." }
}
if (-not (Test-Path -LiteralPath $ImageRoot -PathType Container) -or -not (Test-Path -LiteralPath $ImagePublicKey -PathType Leaf)) {
    throw "Signed image inputs are missing."
}
$programData = [IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\') + '\'
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\')
if (-not ($evidence + '\').StartsWith($programData, [StringComparison]::OrdinalIgnoreCase)) { throw "EvidenceDirectory must remain inside ProgramData." }
if (Test-Path -LiteralPath $evidence) { throw "EvidenceDirectory already exists." }

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installer = Join-Path $PSScriptRoot "zapvm-host-windows.ps1"
$fixture = Join-Path $evidence "fixture"
$installRoot = Join-Path $evidence "installed-host"
$controlState = Join-Path $evidence "control-state"
$controlProcess = $null
$signer = $null
$rootCertificate = $null
$publisherCertificate = $null
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
Protect-Tree $evidence

try {
    $signer = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=zapVM Windows installer acceptance $([Guid]::NewGuid())" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter ([DateTime]::UtcNow.AddDays(1))
    $cer = Join-Path $fixture "release-signer.cer"
    Export-Certificate -Cert $signer -FilePath $cer | Out-Null
    $rootCertificate = Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\CurrentUser\Root"
    $publisherCertificate = Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher"

    Push-Location $repo
    try {
        $releaseOne = Join-Path $fixture "release-one"
        $releaseTwo = Join-Path $fixture "release-two"
        $releaseFault = Join-Path $fixture "release-fault"
        Build-Release "0.1.0-installer-test.1" $releaseOne $signer
        Build-Release "0.1.0-installer-test.2" $releaseTwo $signer
        Build-Release "0.1.0-installer-test.fault" $releaseFault $signer

        $faultSource = Join-Path $fixture "fault-node.go"
        Write-OpenSSLFile $faultSource @'
package main
import (
    "fmt"
    "os"
)
func has(want string) bool { for _, value := range os.Args[1:] { if value == want { return true } }; return false }
func main() {
    if has("--version") { fmt.Println("0.1.0-installer-test.fault"); return }
    if has("--validate") { fmt.Println("acceptance fault node validated"); return }
    if has("--print-daemon-endpoint") { fmt.Println(`\\.\pipe\zapvm-host-installer`); return }
    os.Exit(42)
}
'@
        & $GoCommand build -trimpath -o (Join-Path $releaseFault "zapvm-node.exe") $faultSource
        Assert-Exit "build fault zapvm-node"
        $faultSignature = Set-AuthenticodeSignature -FilePath (Join-Path $releaseFault "zapvm-node.exe") -Certificate $signer -HashAlgorithm SHA256
        if ($faultSignature.Status -ne [Management.Automation.SignatureStatus]::Valid) { throw "Fault node signing failed." }
    } finally {
        Pop-Location
    }

    $caConfig = Join-Path $fixture "ca.cnf"
    Write-OpenSSLFile $caConfig @'
[req]
distinguished_name = dn
x509_extensions = ca
prompt = no
[dn]
CN = zapVM Windows installer acceptance CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
'@
    & $OpenSSLCommand req -x509 -newkey rsa:2048 -nodes -days 1 -config $caConfig -keyout (Join-Path $fixture "ca.key") -out (Join-Path $fixture "ca.pem") | Out-Null
    Assert-Exit "openssl acceptance CA"
    Issue-TLSCertificate $fixture "control" "spiffe://installer.test/control/primary" "serverAuth"
    Issue-TLSCertificate $fixture "node" "spiffe://installer.test/node/host-installer-test" "clientAuth"

    [IO.File]::WriteAllText((Join-Path $fixture "model.key"), "test-model-secret`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture "search.key"), "test-search-secret`n", [Text.UTF8Encoding]::new($false))
    $acceptanceImagePublicKey = Join-Path $fixture "image-public.pem"
    Copy-Item -LiteralPath $ImagePublicKey -Destination $acceptanceImagePublicKey
    $endpoint = "\\.\pipe\zapvm-host-installer"
    $daemonConfig = Join-Path $fixture "daemon.json"
    $nodeConfig = Join-Path $fixture "cloud-node.json"
    $controlConfig = Join-Path $fixture "cloud-control.json"
    Write-JSONFile $daemonConfig ([ordered]@{
        schema_version = 1; endpoint = $endpoint; image_root = [IO.Path]::GetFullPath($ImageRoot); image_public_key = $acceptanceImagePublicKey
        state_root = (Join-Path $evidence "daemon-state"); max_workers = 2; max_per_workspace = 1
        credentials = @(@{id="model-api-key";path=(Join-Path $fixture "model.key")}, @{id="search-api-key";path=(Join-Path $fixture "search.key")})
    }) 5
    Write-JSONFile $nodeConfig ([ordered]@{
        schema_version = 1; control_url = "https://127.0.0.1:$ControlPort"; trust_domain = "installer.test"; control_id = "primary"; node_id = "host-installer-test"
        server_ca = (Join-Path $fixture "ca.pem"); certificate = (Join-Path $fixture "node.pem"); private_key = (Join-Path $fixture "node.key")
        daemon_endpoint = $endpoint; poll_ms = 250; max_concurrent = 2
    }) 5
    Write-JSONFile $controlConfig ([ordered]@{
        schema_version = 1; listen = "127.0.0.1:$ControlPort"; state_root = $controlState; trust_domain = "installer.test"; control_id = "primary"
        client_ca = (Join-Path $fixture "ca.pem"); certificate = (Join-Path $fixture "control.pem"); private_key = (Join-Path $fixture "control.key")
        heartbeat_ttl_seconds = 10; lease_ttl_seconds = 30; administrators = @("spiffe://installer.test/tenant/acme/project/default/client/admin")
        nodes = @(@{id="host-installer-test";capacity=2;scopes=@(@{tenant_id="acme";project_id="default"});computers=@(@{id="computer-installer-test";tenant_id="acme";project_id="default"})})
    }) 8
    Protect-Tree $evidence

    $controlExe = Join-Path $fixture "zapvm-control.exe"
    Push-Location $repo
    try {
        & $GoCommand build -trimpath -ldflags "-X main.version=0.1.0-installer-test.control" -o $controlExe ./cmd/zapvm-control
        Assert-Exit "build zapvm-control"
    } finally { Pop-Location }
    & $controlExe --config $controlConfig --validate | Set-Content -LiteralPath (Join-Path $evidence "control-validate.log")
    Assert-Exit "validate control"
    $controlProcess = Start-Process -FilePath $controlExe -ArgumentList @("--config", $controlConfig) -RedirectStandardOutput (Join-Path $evidence "control.log") -RedirectStandardError (Join-Path $evidence "control-error.log") -PassThru
    Start-Sleep -Seconds 1
    if ($controlProcess.HasExited) { throw "Acceptance Control exited before Host installation." }

    $statePath = Join-Path $controlState "state.json"
    Invoke-Logged $installer @("install", "-SourceDirectory", $releaseOne, "-DaemonConfig", $daemonConfig, "-NodeConfig", $nodeConfig, "-SignerThumbprint", $signer.Thumbprint, "-InstallRoot", $installRoot) (Join-Path $evidence "install.log")
    Wait-NodeVersion $statePath "0.1.0-installer-test.1"
    Invoke-Logged $installer @("doctor", "-InstallRoot", $installRoot) (Join-Path $evidence "doctor-install.log")

    Invoke-Logged $installer @("upgrade", "-SourceDirectory", $releaseTwo, "-DaemonConfig", $daemonConfig, "-NodeConfig", $nodeConfig, "-InstallRoot", $installRoot) (Join-Path $evidence "upgrade.log")
    Wait-NodeVersion $statePath "0.1.0-installer-test.2"
    Invoke-Logged $installer @("rollback", "-InstallRoot", $installRoot) (Join-Path $evidence "rollback.log")
    Wait-NodeVersion $statePath "0.1.0-installer-test.1"

    $failed = $false
    try {
        Invoke-Logged $installer @("upgrade", "-SourceDirectory", $releaseFault, "-DaemonConfig", $daemonConfig, "-NodeConfig", $nodeConfig, "-InstallRoot", $installRoot) (Join-Path $evidence "failed-upgrade.log")
    } catch { $failed = $true }
    if (-not $failed) { throw "Faulting Node upgrade unexpectedly succeeded." }
    if (-not (Get-Content -LiteralPath (Join-Path $evidence "failed-upgrade.log") -Raw).Contains("previous release was restored")) { throw "Failed upgrade did not report automatic restoration." }
    Wait-NodeVersion $statePath "0.1.0-installer-test.1"

    Get-CimInstance Win32_Service -Filter "Name='zapvm' OR Name='zapvm-daemon' OR Name='zapvm-node'" | Format-List * | Out-File (Join-Path $evidence "services-before-uninstall.log")
    Invoke-Logged $installer @("uninstall", "-InstallRoot", $installRoot) (Join-Path $evidence "uninstall.log")
    foreach ($service in @("zapvm", "zapvm-daemon", "zapvm-node")) {
        if ($null -ne (Get-Service -Name $service -ErrorAction SilentlyContinue)) { throw "Service $service remains after uninstall." }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot "releases"))) { throw "Uninstall removed retained release evidence." }
    Write-Output "WINDOWS_HOST_INSTALL_ACCEPTANCE_OK evidence=$evidence"
} finally {
    if ($null -ne $controlProcess -and -not $controlProcess.HasExited) { Stop-Process -Id $controlProcess.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath (Join-Path $installRoot "host-state.json")) {
        & $installer uninstall -InstallRoot $installRoot | Out-Null
    }
    foreach ($service in @("zapvm-node", "zapvm-daemon")) {
        if ($null -ne (Get-Service -Name $service -ErrorAction SilentlyContinue)) { & sc.exe stop $service | Out-Null; & sc.exe delete $service | Out-Null }
    }
    if ($null -ne (Get-Service -Name "zapvm" -ErrorAction SilentlyContinue)) {
        $cleanupZap = Join-Path (Join-Path $fixture "release-one") "zapvm.exe"
        if (Test-Path -LiteralPath $cleanupZap) { & $cleanupZap service uninstall | Out-Null }
    }
    if ($null -ne $signer) {
        Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $signer.Thumbprint) -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ("Cert:\CurrentUser\Root\" + $signer.Thumbprint) -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ("Cert:\CurrentUser\TrustedPublisher\" + $signer.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
}
