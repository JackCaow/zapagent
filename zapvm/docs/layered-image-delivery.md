# Layered image delivery

zapVM image schema 3 separates the parts of an Agent Computer that change at
different rates. The complete release is still authorized by one Ed25519
manifest and one TUF target, but each signed file belongs to exactly one
versioned layer.

The lifecycle deliberately follows the proven Agent Computer pattern of a
replaceable system image, a replaceable guest-tools image, and a preserved data
disk. zapVM keeps Runtime and Agent separate so a Resident Agent update does
not imply an OS or VMM update. This is an architectural compatibility input;
zapVM does not depend on undocumented third-party image formats or services.

| Layer | Contents | Update behavior |
|---|---|---|
| Base | `rootfs.raw`, `rootfs.vhdx` | Immutable Alpine userspace; changed only for OS/package updates. |
| Runtime | kernel, initramfs, guest RPC runtime, Host VMM runtime, capabilities, provenance, SPDX SBOM and corresponding-source offer | Updated with the Host/guest protocol contract. |
| Agent | Independently signed `agent.raw` and `agent.vhdx` exposing `/opt/zapvm-agent/bin/agent`, plus signed build provenance | Read-only disk; an ACP Agent can be replaced without rebuilding Base or Runtime. |
| Session | `state.raw`, `state.vhdx` templates | Sparse writable per-Computer state; migrations are monotonic and never rolled back. |
| Workspace | Explicit Host directory share | Not part of an image and never copied into an update bundle. |

The production builder emits the schema-3 `host-runtime` profile:

- `host-runtime` is the default external-Agent and pluggable-Agent delivery. It
  contains Base, Runtime, and Session layers only. It must not contain an Agent
  disk, Agent provenance, or ZapCode. The `zapvm-resident-agent` Resident
  protocol adapter belongs to Runtime; without a compatible signed Agent
  package it has no Agent executable to launch.
- A Resident product composes that Runtime with an independently signed Agent
  package at install or placement time. The Runtime image itself never embeds
  ZapCode, Dim, or another Agent implementation.

Both profiles assign every signed file exactly once and put required raw and
VHDX artifacts in the correct layer. Unknown profiles, duplicate membership,
missing layers, unsafe names, unassigned files, and Agent files in a Host
composition fail closed.

The Runtime layer contains both `sbom.spdx.json` and `source-offer.json` under
the image signature. The offer binds every SPDX package ID, name, version, and
declared license to an immutable HTTPS source locator, revision, and source
path; release-source archives also carry a SHA-256 lock. Verification rejects
unknown licenses, incomplete or duplicate coverage, identity drift, unsafe
locators, unknown fields, and trailing data before an image can be activated.
This signed index is the machine-enforced source identity contract. Production
publication must additionally retain or mirror the referenced source and pass
the legal/license review in `release.md`.

## Guest boot contract

The Host always attaches Base read-only and Session read-write. An explicitly
selected independent Agent package attaches Agent read-only. The
guest finds the Agent disk by its ext4 label `zapvm-agent`, mounts it at
`/opt/zapvm-agent` with `ro,nosuid,nodev`, and accepts only a regular executable
`/opt/zapvm-agent/bin/agent`. The Runtime invokes `agent acp`; there is no
fallback to an Agent binary in Base.

Workspace, bootstrap secrets, and Session state keep their existing separate
mount and authorization boundaries. The Agent disk is never writable by the
workload.

## Build contract

`scripts/build-rootfs.sh` builds only the generic `host-runtime` profile and
emits no Agent artifacts:

```bash
ZAPVM_IMAGE_VERSION=1.12.0 \
ZAPVM_IMAGE_PROFILE=host-runtime \
./scripts/build-rootfs.sh arm64
```

Build the Agent layer independently from a staged ACP Agent root:

```bash
ZAPVM_AGENT_ROOT=/absolute/path/to/acp-agent-root \
ZAPVM_AGENT_ID=dim \
ZAPVM_AGENT_VERSION=0.3.12 \
ZAPVM_AGENT_CREATED_AT=2026-08-16T00:00:00Z \
ZAPVM_AGENT_SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 \
ZAPVM_AGENT_BUILD_TARGET=bun-linux-arm64 \
ZAPVM_AGENT_BUILDER_VERSION=1 \
./scripts/build-agent-package.sh arm64
```

Real Agent builds require the exact source commit, build target, builder
version, and payload SHA-256 in signed `agent-provenance.json`. Public stub
builds record `unavailable` provenance explicitly.

The build writes into a private staging directory and renames it into place
only after all disk formats, provenance, SBOM, source offer, and the schema 3
manifest have been produced. The manifest is validated before it is written.

Linux runtime builds pin both the virtiofsd source/builder image and the final
architecture-specific binary SHA-256 in `packaging/linux/runtime-lock.env`.
Release CI builds from source by default. A repeated local build may set
`ZAPVM_USE_RUNTIME_CACHE=1`; that path accepts only the existing build-tree
binary whose architecture, static linkage, builder metadata, and digest match
the lock, otherwise it fails closed. The unsigned `rootfs.tar` export is
deleted immediately after populating the immutable filesystem and never enters
the final image directory or manifest.

Base builds use the digest-pinned Alpine multi-architecture image and the
per-architecture `/lib/apk/db/installed` hash/package count in
`packaging/guest/rootfs-lock.env`. The builder checks that closure before it
exports the root filesystem. Repository drift therefore stops the build with
an explicit Base-version bump/review request instead of producing different
bytes under an existing layer version. Updating either architecture's closure
requires updating `ROOTFS_BASE_VERSION` in the same reviewed lock.

The input files `rootfs-packages-{arm64,amd64}.lock` also pin the complete
dependency closure as `name=version` constraints. The installer verifies their
digest, count, syntax, and unique package names before calling apk, and retains
Alpine signature verification. This prevents an unrelated upstream update from
changing the chosen package set. PR CI installs and checks both architectures.
Alpine mirrors may remove old versions; an unavailable exact version remains an
explicit build failure. There is no automatic lock refresh or unpinned fallback.
Retain exact APKs in an approved mirror when long-term rebuild availability is
required; version constraints alone do not archive upstream artifacts.

For Base `alpine-3.23.5-r5`, the reviewed change from r4 is pcre2
`10.48-r0 -> 10.49-r0`, and the four Python-origin packages (python3, pyc,
python3-pyc, python3-pycache-pyc0) `3.12.14-r0 -> 3.12.15-r0`. Package counts,
declared licenses, and all other arm64 package versions are unchanged. Both
architectures were installed again using the exact constraints and their complete
installed databases matched the newly reviewed hashes. A future refresh must
compare package identities, versions, source revisions, and licenses, run both
architecture checks and native Guest acceptance, then bump the Base version and
update both input and output hashes in the same change.

Open-source platform, external-Agent, and Resident-Agent acceptance all use
`host-runtime`. There is no placeholder Agent disk and no Agent implementation
in that image. A Resident product selects an independently signed Agent package;
the Runtime and package must pass exact-payload candidate smoke on every claimed
platform.

## Independent Agent packages

Runtime and Agent use separate Ed25519 trust roots and activation records. An
independent package directory contains `agent.json`, raw `agent.sig`,
`agent.raw`, `agent.vhdx`, and `agent-provenance.json`. The signed manifest
binds Agent identity/version, Host architecture, Runtime protocol, Resident
adapter contract (`acp-resident-v1` in schema 1), compatible Session-state
schema range, entrypoint, and every payload size/hash.

Create, sign, install, activate, and boot an Agent without rebuilding Runtime:

```bash
ZAPVM_AGENT_ROOT=/absolute/path/to/staged-acp-agent-root \
ZAPVM_AGENT_ID=dim \
ZAPVM_AGENT_VERSION=1.12.0 \
ZAPVM_AGENT_CREATED_AT=2026-08-13T00:00:00Z \
ZAPVM_AGENT_SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 \
ZAPVM_AGENT_BUILD_TARGET=bun-linux-arm64-musl \
ZAPVM_AGENT_BUILDER_VERSION=1.3.0 \
ZAPVM_AGENT_SIGNING_PRIVATE_KEY=/absolute/path/agent-private.pem \
./scripts/build-agent-package.sh arm64

zapvm agent install \
  --root /absolute/path/agents \
  --public-key /absolute/path/agent-public.pem \
  --manifest ./agent.json --signature ./agent.sig
zapvm agent use \
  --root /absolute/path/agents \
  --public-key /absolute/path/agent-public.pem \
  zapcode@1.12.0
zapvm verify \
  --agent active \
  --agent-root /absolute/path/agents \
  --agent-public-key /absolute/path/agent-public.pem
```

`agent use` checks the active signed Runtime protocol, architecture, state
schema, and explicit Resident adapter contract, then boots the exact Runtime +
Agent candidate and runs the VM smoke before replacing `active-agent.json`
atomically. A Computer stores an
exact `id@version` reference, and that Agent manifest digest is part of the VM
pool route; changing Agent therefore cannot reuse a worker created under a
different executable authority. Per-Computer Session state remains preserved.

The first implementation is a local/offline registry. Online TUF distribution,
multi-Agent hot-plug, and switching a running VM are intentionally outside this
contract; switching stops/recreates the worker at the next route acquisition.

## Update state machine

Schema 3 has two transport forms backed by the same signed manifest:

- a complete deterministic bundle for offline installation, target-host
  acceptance, and disaster recovery;
- an online composition target containing only `manifest.json` and
  `manifest.sig`, plus the three deterministic Runtime layer targets. Each
  layer target is a separate TUF target and is reused from the verified Warm
  Cache when its bytes are unchanged.

`zapvm-image bundle-layers` creates the composition and its declared layer archives in
an atomically published output directory. Its `layer-targets.json` is an
unsigned publication aid: `target-metadata --layer-target-index ...
--layer-target-prefix ...` verifies the index and all referenced archives,
then emits custom metadata schema 3 with the exact TUF paths. The Ed25519 image
manifest, not the index, remains the authority for layer membership, file size,
and file hash.

Production updates follow this order:

1. Refresh the offline-pinned TUF root, timestamp, snapshot, and targets.
2. Prefer `channels/<channel>/<arch>.composition.tar.zst`, then fall back to
   `channels/<channel>/<arch>.bundle.tar.zst` (legacy gzip remains readable).
   Composition targets require signed TUF custom metadata schema 3, which binds
   the exact declared layer version vector and three or four unique layer
   target paths. Complete schema 3 bundles remain compatible with metadata
   schema 2.
3. Reuse a content-addressed Warm Cache object only after rechecking its trusted
   length and every TUF hash; otherwise download to a private temporary file.
4. For a composition update, verify its TUF hash, manifest hash, and Ed25519
   signature before resolving the declared TUF layer targets. Download only targets
   absent from the verified content-addressed Warm Cache, then stream-recompose
   the candidate in private staging. A complete bundle is streamed directly.
5. Verify exact layer/archive membership, Ed25519 manifest, every file size/hash,
   architecture, layer contract, runtime provenance, and anti-rollback ledger.
6. Install the version into an append-only version directory without changing
   `active.json`.
7. Run `zapvm image-smoke --image-version <candidate>` using a temporary Session
   disk and workspace. It must boot the real backend, authenticate guest RPC,
   confirm read-only Base, read-write state, capability data, Zap availability,
   and the read-only Agent mount, then stop cleanly.
8. Atomically replace `active.json`, retain the previous version, and commit the
   release ledger.
9. Retain at most four verified content-addressed bundles, always preserving the
   bundle used by the current update.

Release tooling must derive, not hand-author, the TUF custom metadata from the
already signed manifest:

```bash
zapvm-image target-metadata \
  --manifest /release/manifest.json \
  --signature /release/manifest.sig \
  --public-key /etc/zapvm/image-public.pem \
  --release-sequence 42 \
  --output /release/target-custom.json
```

The command verifies the manifest signature and every declared file before
writing a new, fsynced, non-overwriting metadata file. A schema 3 manifest
produces custom metadata schema 2 with its exact three- or four-layer version
vector.

`update` and activating `install-bundle` discover a sibling `zapvm` binary by
default. Packagers can pin it explicitly with `--smoke-binary`. Activation is
rejected if the executable is missing, the VM fails to boot, a check fails, or
the success marker is absent. `--skip-smoke` is an audited emergency escape
hatch and prints a warning; it is not allowed in normal release automation.

```bash
zapvm-image update \
  --root /var/lib/zapvm/images \
  --trusted-root /etc/zapvm/tuf-root.json \
  --manifest-public-key /etc/zapvm/image-public.pem \
  --metadata-url https://updates.example.com/metadata \
  --targets-url https://updates.example.com/targets \
  --tls-ca /etc/zapvm/enterprise-update-ca.pem \
  --channel stable --arch arm64 \
  --smoke-binary /usr/local/bin/zapvm
```

`--tls-ca` is optional and appends a bounded PEM CA bundle to the operating
system trust roots. It exists for private enterprise/CDN origins and staging
acceptance; invalid, non-regular, or relative CA inputs fail closed. There is
no option to disable certificate or hostname verification.

Release-side example:

```bash
zapvm-image bundle-layers \
  --manifest /release/image/manifest.json \
  --signature /release/image/manifest.sig \
  --public-key /release/image-public.pem \
  --output-dir /release/layer-targets

zapvm-image target-metadata \
  --manifest /release/image/manifest.json \
  --signature /release/image/manifest.sig \
  --public-key /release/image-public.pem \
  --release-sequence 42 \
  --layer-target-index /release/layer-targets/layer-targets.json \
  --layer-target-prefix layers/arm64 \
  --output /release/target-custom.json

zapvm-image tuf-repository \
  --layer-target-dir /release/layer-targets \
  --custom-metadata /release/target-custom.json \
  --root-private-key /release/keys/root-private.pem \
  --targets-private-key /release/keys/targets-private.pem \
  --snapshot-private-key /release/keys/snapshot-private.pem \
  --timestamp-private-key /release/keys/timestamp-private.pem \
  --channel rc --arch arm64 \
  --root-expires 2027-08-12T00:00:00Z \
  --targets-expires 2026-11-12T00:00:00Z \
  --snapshot-expires 2026-09-12T00:00:00Z \
  --timestamp-expires 2026-08-19T00:00:00Z \
  --output-dir /release/repository-arm64
```

`tuf-repository` verifies the schema 3 custom metadata, layer index, and every
indexed archive size/SHA-256 before it writes a consistent-snapshot repository.
It requires four different Ed25519 role keys, canonical UTC expiries ordered as
timestamp < snapshot < targets < root, positive metadata versions, a new output
directory, and fsynced atomic publication. It never copies private keys into the
repository. The single-process command is deliberately restricted to development,
RC, and staging channels: `stable`, `production`, and `prod` require separately
operated production roles and the ceremony described in `release.md`.
Each independently served repository (including an architecture-specific
repository) must use its own root and role-key domain. Reusing one role key set
to sign different metadata bytes at the same version is equivocation and is
prohibited. A deployment that needs one shared root must instead publish all
architectures in one jointly versioned repository through the separated-role
production ceremony.

Rollback re-verifies the previous signed version and atomically swaps the
active/previous pointers. It never rolls Session schema backward and never
deletes either version.

## Update impact and Session continuity

| Changed layer | Required action | Preserved data |
|---|---|---|
| Agent only | Drain admitted commands, restart/reconnect Resident Agent, run candidate smoke | Computer Session disk and Workspace |
| Runtime | Drain VM, boot candidate kernel/guest RPC/VMM contract, run candidate smoke | Computer Session disk and Workspace |
| Base | Drain VM, replace immutable userspace, run state migration and candidate smoke | Computer Session disk and Workspace |
| Session template/schema | New Computers use the new template; existing disks migrate monotonically on boot | Existing Session content; schema never rolls back |

An activation generation pins every admitted command to one verified image
composition. The active pointer is changed only after the candidate has booted
with a temporary Session disk. Existing writable Session disks are never part
of a download, never overwritten by activation, and never selected as a
rollback target.

## Release acceptance

A release is deliverable only when all of these are retained as evidence for
the exact bundle digest:

- manifest schema/layer and malicious-archive tests;
- deterministic Zstd bundle and Warm Cache tests;
- activation rejection on failed candidate smoke;
- signed install, activation, rollback, and persistent Session migration;
- real macOS arm64, Linux amd64 KVM, and Windows amd64 HCS candidate boot;
- native Host package signature/notarization gates for any platform claimed;
- staging HTTPS/TUF publication and clean-machine update/rollback.

Cross-compilation or a unit test is not a substitute for real-host acceptance.
