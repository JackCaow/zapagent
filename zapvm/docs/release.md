# Release process

This process separates building, signing, publishing, activation, and platform
acceptance. Completion of one stage is not evidence that a later stage passed.

macOS Host packages default to ad-hoc signing for reproducible CI verification.
A distributable package must set `ZAPVM_MACOS_SIGN_IDENTITY` to the reviewed
personal Developer ID Application identity before running
`scripts/package-host-release.sh`; release evidence must record that identity
and verify the extracted binaries with `codesign --verify --strict`.

## Release roles and keys

- TUF root: offline, threshold-controlled, used only for root rotation.
- TUF targets: controlled release signing identity.
- TUF snapshot/timestamp: online publishing identities with narrowly scoped
  access.
- Image manifest: production Ed25519 key held in an HSM/KMS or an isolated
  signing service.
- Host packages: Developer ID/notarization on macOS, Authenticode on Windows,
  and signed repository metadata for Linux packages.
- GitHub Actions: OIDC and environment protection; no long-lived general GitHub
  token in a build environment.

`ZAPVM_IMAGE_SIGNING_PRIVATE_KEY` is acceptable only for an explicitly labeled
development or acceptance environment. A stable release must not expose an
exportable production private key to a general-purpose runner.

The private repositories currently use a GitHub plan that does not expose
branch protection, rulesets, or protected Environment reviewers. The release
workflow therefore also rejects lightweight, unsigned, invalid, off-main, and
commit-mismatched tags before any packaging or signing job can run. This is a
fail-closed compensating control, not a replacement for protected branches and
review-gated signing environments; stable publication still requires a plan
upgrade, making the repository public with the documented protections, or an
equivalent external release system.

Before pushing a release tag, register the operator's GPG/SSH public key as a
GitHub signing key, update `main` by fast-forward only, and verify the local
signature. Lightweight tags are intentionally unsupported:

```bash
git switch main
git pull --ff-only
git tag -s v0.3.0 -m "zapVM v0.3.0"
git tag -v v0.3.0
git push origin refs/tags/v0.3.0
```

## Required repository settings

Configure the settings in `maintainer-guide.md` before enabling tag publication.
In particular, protect the release environment with required reviewers and
enable private vulnerability reporting.

## Release gates

1. Source
   - clean tagged commit on `main`;
   - GitHub-verified annotated signed tag resolving exactly to that commit;
   - PR CI, CodeQL, dependency review, vulnerability scan, tests, race, vet;
   - changelog and compatibility review.
2. Supply chain
   - reproducible image inputs are digest pinned;
   - the Alpine image digest and exact per-architecture installed APK database
     hash/package count match `packaging/guest/rootfs-lock.env`; a reviewed
     package change uses a new `ROOTFS_BASE_VERSION`;
   - `rootfs-packages-{arm64,amd64}.lock` constrains every direct and transitive
     package to an exact version before installation; its digest and count
     are checked before package-network access. Missing pinned versions stop
     the build rather than retrying against newer packages;
   - every Host package is built twice from the same tagged commit with
     `SOURCE_DATE_EPOCH` set to that commit timestamp, and the two archives are
     byte-for-byte identical before either archive can be uploaded;
   - schema 3 records the intended Base, Runtime, Agent, and Session versions,
     and every signed file belongs to exactly one layer;
   - SPDX SBOM validates and contains no unknown license;
   - the signed source offer covers every SPDX package exactly once and passes
     `zapvm-image verify`, which rejects identity/license drift and unsafe or
     malformed corresponding-source locators;
   - required license texts and corresponding source are retained or mirrored,
     their immutable locators are independently fetched, and legal review has
     approved the exact image SBOM/source-offer pair;
   - Host artifacts include checksums and provenance.
   - `zapvm-image target-metadata` derives the TUF custom metadata from the
     verified signed manifest; release operators do not hand-author the layer
     vector or manifest digest.
3. Signing
   - manifest and TUF metadata use the correct release roles;
   - Host packages pass native signature verification;
   - no acceptance/development key is trusted by the stable channel.
4. Functional acceptance
   - exact signed artifact runs on every platform claimed by the release;
   - native acceptance records the Host archive SHA-256, image bundle SHA-256,
     public-key SHA-256, and source commit together; after merge, repeat the
     native gate on the exact final `main` commit and tag that same commit;
   - the staged candidate passes `zapvm image-smoke` before `active.json`
     changes, and a deliberately failed smoke leaves the old image active;
   - workspace, network, credential, state, crash, daemon, and cleanup gates
     pass with retained artifact digests.
5. Publication
   - create a draft GitHub release first;
   - publish immutable targets and metadata to HTTPS/CDN staging;
   - run `verify-host-release.sh` / `verify-host-release.ps1` against the exact
     archive from a clean extraction before promoting the channel pointer.
6. Rollback
   - retain the previous Host package, image, and metadata;
   - test Host package rollback and image rollback without state downgrade;
   - document revocation actions before activation.

## Artifact naming

```text
zapvm_<version>_darwin_arm64.tar.gz
zapvm_<version>_darwin_amd64.tar.gz
zapvm_<version>_linux_arm64.tar.gz
zapvm_<version>_linux_amd64.tar.gz
zapvm_<version>_windows_arm64.zip
zapvm_<version>_windows_amd64.zip
zapvm-image_<version>_<arch>.bundle.tar.zst
SHA256SUMS
```

Each Host archive contains sibling `zapvm`, `zapvm-node`, `zapvm-image`, and
`zapvm-sbom` binaries, the platform `zapvm-host-install` entry point, and
owner-editable daemon/Node configuration examples. The installation, platform
Host, Node operations, and Agent integration guides are included under `docs/`
so an extracted package does not depend on a mutable documentation site. This
lets the verified archive become either a local CLI installation or a remote
Agent Host without fetching a second binary from another release. It also
contains `LICENSE`,
`NOTICE`, and `THIRD_PARTY_NOTICES.md`. Image bundles contain their per-image
SPDX SBOM, corresponding-source offer, and the profile-specific Base/Runtime/Session
or Base/Runtime/Agent/Session layer
artifacts.

The generic archive does not replace platform production signing. macOS stable
artifacts still require Developer ID signing and notarization, Windows requires
Authenticode, and the Linux service installer requires a separately signed
`SHA256SUMS` release directory. Node credentials and daemon configuration are
never embedded in a public Host archive.

Host packaging normalizes archive entry ownership, ordering, timestamps, and
compression metadata. The tag workflow rebuilds each platform package in a
second clean output directory and rejects any byte difference. A package built
from a PR commit is therefore a preview candidate only: if merge changes the
commit or packaged documentation, the final `main` candidate must be rebuilt
and accepted again. Do not put a Host archive's own digest into packaged source
documentation; record it in release evidence and `SHA256SUMS` instead.

## Stable-release blockers

Do not publish a stable release while `roadmap-to-1.0.md` has an open required
gate. Preview releases must name unsupported platforms and unsigned package
limitations prominently; they must not silently downgrade to Host execution.
