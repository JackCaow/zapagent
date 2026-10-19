# zapAgent / zapVM monorepo

## Source import

zapVM main `b9b29bae4ed89692c2aff20911dc7f3acb3b2cc5` was imported under
`zapvm/` with an unrelated-history merge and prefix tree import. Its full history
is a parent of the import commit, not a squashed archive or a Git submodule.
Local uncommitted files, generated artifacts, runtime disks and credentials were
not imported. The old repository remains available; do not archive it before
the migration is reviewed and merged.

Merge this migration with a normal merge commit, **not squash or rebase merge**:
flattening the import would discard the VM ancestry from main. Verify that the
original VM main commit is still an ancestor of main after merging.

## Ownership and compatibility

| Component | Source | Contract |
| --- | --- | --- |
| CLI/TUI | `src/` | Existing profile, config and command compatibility |
| Agent/Harness | `zapsdk/` | ExecutionBackend and HostProtocol |
| VM | `zapvm/` | Independent `go.mod`, CLI, daemon/Guest protocol |
| Distribution | root `scripts/`, `packaging/`, `.github/workflows/` | One reviewed source commit |

No VM implementation imports into Agent code. No prompt injection or forced
permission mode from VM. VM execution errors do not redefine Agent completion.
Agent-only use/build does not require Go or a VM. `zapvm/` can independently
build and test with its own Go toolchain; its optional web app keeps npm/Vitest.
Internal module versions need not match the product version. Keep Apache-2.0
and third-party notices with the VM; root npm package contents remain unchanged.

## Root commands

- `bun run build`: Agent executable only.
- `bun run build:vm`: native VM Host and image tool in `dist/zapvm-host/`.
- `bun run build:all`: both, without creating an image or publishing anything.
- `bun test`: Agent/SDK tests; VM frontend excluded through Bun configuration.
- `bun run test:vm`: Go tests.
- `bun run check:all`: existing Agent gates plus VM baseline, Go tests and vet.

`zapvm/web/client/react` remains a separate npm project; use `npm ci`,
`npm test`, `npm run check` and `npm run build` there. Browser E2E and native
VM target-host acceptance remain separate, opt-in validation, not unit tests.

## CI and release

Root workflows check both modules. Imported nested workflows are historical
references, not active workflows; self-hosted/cloud acceptance is not silently
enabled by migration. Restore those workflows at the root only after reviewing
runner labels, credentials and path changes.

Release jobs use `zapvm/` from the same checkout as the Agent. There is no second
repository token or moving VM ref. `runtime-package.json` records that commit;
source offers point to the monorepo archive and `zapvm` directory. Guest images
use the `host-runtime` profile; separately signed ACP Agent packages remain
optional and are not embedded by the product release pipeline.

The existing multi-platform workflow assembles candidate packages and keeps the
GitHub Release in draft. Its ad-hoc macOS signing is not a formal distribution
gate. Promotion still requires Developer ID signing, notarization, checksum and
runtime validation; migration does not republish 1.13.0 or alter installed tools.
Image package-closure drift remains fail-closed (including architectures not
distributed by the current macOS arm64 release).

## Migration verification

Validate the import ancestry with `git merge-base --is-ancestor
b9b29bae4ed89692c2aff20911dc7f3acb3b2cc5 HEAD`. Run the full Bun suite with
PTY acceptance enabled and an isolated `ZAPCODE_DATA_DIR`, VM baseline/tests/vet
and race detector, active-root actionlint, and the separate web-client suite.
Host smoke can use the already signed 1.13.0 image; this verifies protocol
compatibility, not a rebuild of that Guest image or a new formal release.

The imported frontend lock currently reports two moderate findings in the
Vitest/mocker development dependency chain (GHSA-82fw-gwwq-j7x9). The migration
does not silently update its dependency graph. The frontend CI audit fails on
high/critical severity; fixing the existing moderate dev-tool advisory is a
separate dependency update, not evidence that all security checks are clean.
