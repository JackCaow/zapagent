# Installation

The macOS Homebrew product installs the Host tools and an exact, SHA-pinned
signed Agent Computer image as one reviewed package. The Formula pins both the
Host archive and image resource, installs the image public key, verifies the
Ed25519 manifest and every declared artifact, and boots the candidate before
activation. A failed signature, hash, architecture check, or VM smoke test
fails installation.

## Prerequisites

- macOS: Virtualization.framework support; release binaries require the
  Virtualization entitlement and a valid project release signature.
- Linux: x86_64 or arm64, `/dev/kvm`, cgroup v2, systemd 254+, and a usable
  systemd user manager.
- Windows: Windows Server/Windows with Hyper-V, HCS, and HCN; an elevated
  PowerShell is required only to install the protected LocalSystem service.

Run `zapvm doctor` before downloading an image. See `support-matrix.md` for the
combinations with retained real-host evidence.

## Homebrew (macOS Apple Silicon)

The public tap installs the signed and notarized Host tools, signed Agent
Computer image, pinned image public key, and offline documentation:

```bash
brew tap JackCaow/zapvm
brew install zapvm
zapvm verify
```

`zapvm verify` checks the Host, re-verifies the active signed image, boots the
real Virtualization.framework VM, authenticates the guest RPC runtime, and
requires the resident Agent. Success ends with `ZAPVM_AGENT_COMPUTER_OK`.

The Formula-provided environment makes ordinary commands use the installed
image without internal path flags:

```bash
mkdir -p "$HOME/zapvm-workspace"
zapvm run --workspace "$HOME/zapvm-workspace" --stop-after-exec -- uname -a
```

## Release archive

Download `scripts/install.sh` or `scripts/install.ps1` from the same release/tag
you intend to install and review it before execution.

macOS/Linux:

```bash
./scripts/install.sh v0.2.0
```

Windows PowerShell:

```powershell
.\scripts\install.ps1 -Version v0.2.0
```

An enterprise HTTPS mirror can be selected with
`ZAPVM_RELEASE_BASE_URL=https://releases.example/zapvm/v0.2.0`. Plain HTTP is
rejected. The mirror must expose the platform archive and `SHA256SUMS` at that
exact base URL; native package signatures and the pinned image/TUF trust roots
remain mandatory.

Installers verify the release archive against the release `SHA256SUMS`. Native
package signing is an additional stable-release gate; a checksum does not
replace Developer ID/notarization, Authenticode, or TUF/image signatures.

The archive installs `zapvm`, `zapvm-node`, `zapvm-image`, `zapvm-sbom`, and the
platform `zapvm-host-install` entry point. It also carries `examples/daemon.json`,
`examples/cloud-node.json`, and `examples/cloud-node-managed.json` as templates;
the generic installer copies these templates and the offline guides into the
platform share directory but deliberately does not activate them because a Node
identity, mTLS authority, image trust root, and protected Host paths must be
provisioned for the intended tenant and project. Follow the matching
[macOS](./host-install-macos.md), [Linux](./host-install-linux.md), or
[Windows](./host-install-windows.md) Host guide to join Control.

## Manually managed guest image

Non-Homebrew, enterprise, and development installations may still import a
bundle with a separately obtained and pinned image public key:

```bash
zapvm-image install-bundle \
  --bundle /absolute/path/zapvm-image_<version>_<arch>.bundle.tar.zst \
  --public-key /absolute/path/image-public.pem \
  --root /absolute/path/zapvm-images \
  --arch arm64 \
  --smoke-binary /usr/local/bin/zapvm
```

Production online updates additionally require an offline-pinned TUF root. Do
not accept a trust root downloaded from the same unauthenticated location as the
image it is supposed to verify.

## Windows service

From an elevated PowerShell, install the service once from the verified Host
package:

```powershell
zapvm.exe service install
zapvm.exe service status
zapvm.exe doctor
```

Subsequent Agent requests use the current user's protected named-pipe endpoint.
Follow `README.md` for transactional service upgrade and rollback.

## Uninstall

Stop the user daemon before removing binaries. On Windows, run
`zapvm.exe service uninstall` from an elevated PowerShell before deleting the
package. Image and state directories are intentionally not deleted by the Host
tool installer; inspect and remove those separately to avoid data loss.
