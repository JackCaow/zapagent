# Native release-candidate acceptance

`native-candidate-acceptance.yml` is the final Linux KVM and Windows HCS gate
for an exact, already-signed amd64 image candidate. Every job runs on the one
dedicated physical runner selected by `zapvm-physical-<host-id>`; this workflow
does not schedule an authorization, build, or artifact-transfer job on a
GitHub-hosted runner.

The operator stages only the signed image bundle and public key on the target
Host. The workflow verifies operator-pinned SHA-256 values before it builds the
native Host package from the selected Git revision. It then verifies that
package and runs the existing complete platform acceptance using the packaged
`zapvm` and `zapvm-image` binaries rather than rebuilding those executables in
the acceptance script.

## Target prerequisites

Use a runner label assigned to exactly one physical machine:

```text
zapvm-physical-<host-id>
```

Linux requires a non-root login user, systemd 254+, cgroup v2, a working and
user-accessible `/dev/kvm`, a functioning user systemd manager, and the
capabilities checked by `preflight-self-hosted-unix.sh linux-multi`.

Windows requires an elevated runner service on Windows build 20348+ with
Hyper-V/HCS/HNS available and no pre-existing `zapvm` service. The workflow
runs `preflight-self-hosted-windows.ps1 -Target windows-acl-recovery` before
building or installing anything.

Place the two candidate files outside the Actions workspace in an
operator-controlled directory. Inputs must be absolute regular-file paths;
symlinks and Windows reparse points are rejected.

## Direct execution without GitHub Actions

The native scripts are the source of truth used by the workflow. They can be
run directly from an exact detached zapVM revision, so final validation does
not require a merged workflow, a registered runner, or an available Actions
budget.

Host archives are reproducible for an exact source commit. The stable release
sequence is: merge the reviewed change, detach the exact final `main` commit,
build the Host archive twice with that commit timestamp as
`SOURCE_DATE_EPOCH`, confirm byte identity, run native acceptance with the
resulting hash, and tag that same commit. Any source change invalidates the Host
hash and its native evidence.

On Linux, use the prebuilt RC3 Host archive and its operator-pinned hash:

```bash
./scripts/acceptance-native-candidate-linux.sh \
  /var/tmp/zapvm-rc3-linux-evidence \
  0.3.0-rc.3 \
  /srv/zapvm-rc3/zapvm-image_1.12.0-layered-rc3_amd64.bundle.tar.zst \
  /srv/zapvm-rc3/zapvm-image-public.pem \
  0a40cbe1e9d9c7eb16772ed84285483352d5a22a544fff9bf61b8216b7ab0505 \
  178da5377ec3f3f632815e9c7c99dffb473560792a0019deb99feb1327f21dec \
  /srv/zapvm-rc3/zapvm_0.3.0-rc.3_linux_amd64.tar.gz \
  <operator-pinned-host-sha256>
```

On Windows, the entrypoint builds and verifies the native Host archive before
using its packaged binaries. Run it from an elevated PowerShell:

```powershell
.\scripts\acceptance-native-candidate-windows.ps1 `
  -EvidenceDirectory D:\zapvm-rc3\evidence `
  -Version 0.3.0-rc.3 `
  -Bundle D:\zapvm-rc3\zapvm-image_1.12.0-layered-rc3_amd64.bundle.tar.zst `
  -PublicKey D:\zapvm-rc3\zapvm-image-public.pem `
  -BundleSHA256 0a40cbe1e9d9c7eb16772ed84285483352d5a22a544fff9bf61b8216b7ab0505 `
  -PublicKeySHA256 178da5377ec3f3f632815e9c7c99dffb473560792a0019deb99feb1327f21dec
```

Both evidence directories must not already exist. Supplying a prebuilt Windows
Host archive is optional; when supplied, `-HostSHA256` becomes mandatory. When
the archive is built on the target, its resulting hash is recorded in the
candidate identity file.

## RC3 dispatch

The current exact amd64 RC3 identity is:

```text
candidate_version=0.3.0-rc.3
bundle_sha256=0a40cbe1e9d9c7eb16772ed84285483352d5a22a544fff9bf61b8216b7ab0505
public_key_sha256=178da5377ec3f3f632815e9c7c99dffb473560792a0019deb99feb1327f21dec
```

Linux example:

```bash
gh workflow run native-candidate-acceptance.yml \
  --ref codex/layered-image-delivery \
  -f target=linux-kvm \
  -f runner_label=zapvm-physical-linux-a \
  -f confirmation=RUN_NATIVE_CANDIDATE_ACCEPTANCE \
  -f candidate_version=0.3.0-rc.3 \
  -f candidate_bundle_path=/srv/zapvm-rc3/zapvm-image_1.12.0-layered-rc3_amd64.bundle.tar.zst \
  -f candidate_public_key_path=/srv/zapvm-rc3/zapvm-image-public.pem \
  -f candidate_bundle_sha256=0a40cbe1e9d9c7eb16772ed84285483352d5a22a544fff9bf61b8216b7ab0505 \
  -f candidate_public_key_sha256=178da5377ec3f3f632815e9c7c99dffb473560792a0019deb99feb1327f21dec
```

For Windows use `target=windows-hcs`, a Windows-specific dedicated label, and
absolute paths such as
`D:\zapvm-rc3\zapvm-image_1.12.0-layered-rc3_amd64.bundle.tar.zst` and
`D:\zapvm-rc3\zapvm-image-public.pem`.

## Passing evidence

A passing Linux run must end with:

```text
NATIVE_CANDIDATE_ACCEPTANCE_OK target=linux-kvm
```

A passing Windows run must complete both the full HCS acceptance and the
21-point ACL recovery suite, then end with:

```text
NATIVE_CANDIDATE_ACCEPTANCE_OK target=windows-hcs
```

Evidence and the natively built Host archive are retained below
`RUNNER_WORKSPACE` even if GitHub artifact upload is unavailable. Upload is a
best-effort copy, not the source of truth. `candidate-identity.txt` or
`candidate-identity.json` records the Git revision, input paths, pinned image
hashes, native Host archive path, and native Host SHA-256.

Do not promote or merge solely because the workflow file parses. Stable
delivery requires the two real target runs, their retained evidence, protected
merge, production signing, TUF/CDN publication, and clean-machine update plus
rollback verification.
