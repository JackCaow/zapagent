# Changelog

All notable user-visible changes are documented here. The project follows
Semantic Versioning after 1.0; during 0.x, minor versions may include breaking
changes that are called out explicitly.

## Unreleased

### Fixed

- Base r8 refreshes the signed Alpine package closure for both architectures.
- CI and release builds generate the locked web assets before Go embeds them;
  patched frontend dependencies and their npm lockfile are now tracked.

- Guest builds now constrain every direct and transitive Alpine dependency
  before installation, retaining signature and final database checks. Base r5
  records reviewed pcre2/Python updates; both architecture locks run in PR CI.

### Added

- Open-source governance, security, contribution, support, and release policy.
- Pull-request CI, workflow linting, dependency update configuration, and
  security scanning.
- Schema 3 Base/Runtime/Agent/Session image layers, including a separately
  versioned read-only Agent disk on macOS, Linux KVM, and Windows HCS.
- Deterministic Zstd image bundles, verified content-addressed Warm Cache,
  staged real-VM smoke activation, and persistent-state rollback acceptance.
- Independent schema 3 composition and Base/Runtime/Agent/Session TUF targets;
  online updates download only missing verified layers while complete bundles
  remain available for offline installation and disaster recovery.
- Agent integration guidance for external CLI adapters, stdio workers, remote
  gateways, Resident Agent sessions, and Artifact delivery.
- Self-contained Host release archives with `zapvm-node`, the platform service
  installer, and daemon/Node configuration examples for remote Control join.
- Reproducible macOS/Linux tarballs and Windows ZIP archives, with tag releases
  rebuilding each Host package twice and rejecting byte drift before upload.
- Signed Agent-layer provenance binding the Zap source commit, build target,
  builder version, and injected payload SHA-256.
- Exact-candidate self-hosted acceptance that downloads a hash-pinned signed
  Resident Agent image from its private release instead of rebuilding a stub.
- Locked final virtiofsd digests and a verified local runtime-cache path;
  rootfs builds now reuse Host image tools and discard the unsigned rootfs
  export immediately after filesystem population to bound peak disk usage.
- A signed `source-offer.json` maps every exact SPDX package to immutable
  corresponding-source locations and build recipes. Schema 3 verification
  rejects missing coverage, unknown licenses, identity drift, unsafe URLs and
  paths, duplicate package mappings, and malformed metadata before activation.
- Base builds pin the Alpine multi-architecture image digest and fail closed
  when the architecture-specific installed APK database hash or package count
  differs from the reviewed lock. The Base layer version is bound to that lock
  so a mutable package repository cannot silently change existing layer bytes.
- A fail-closed staging/RC TUF repository publisher verifies the signed schema
  3 release vector and all five independent target hashes, requires four
  distinct role keys and ordered explicit expiries, and atomically emits a
  consistent-snapshot repository. Production channel names are rejected so
  stable signing remains a separated-role ceremony.

### Security

- Publication gates for signed images, TUF metadata, SBOM/license review, and
  real-platform acceptance evidence.
- A runner-local native candidate workflow verifies operator-pinned image
  hashes, builds and verifies the native Host package, and executes the exact
  Linux KVM or Windows HCS acceptance without a GitHub-hosted prerequisite job.
- Private update origins can add an explicit bounded PEM CA bundle without
  disabling TLS certificate or hostname verification.
- Minimum Go toolchain raised to 1.26.5 and `golang.org/x/net`/`x/text` updated
  to versions that include current standard-library and Unicode parsing fixes.
- Restricted egress now resolves trusted Host Fake-IP DNS answers through a
  verified direct resolver without accepting private or mixed answers.
- Release workflows reject lightweight, unsigned, invalid, commit-mismatched,
  and off-main tags before packaging or accessing signing material.
