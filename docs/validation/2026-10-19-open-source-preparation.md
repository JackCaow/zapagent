# Open-source preparation — 2026-10-19

This is a private source candidate with new Git history. No original branches,
tags, releases, credentials or ignored development files were imported. The
export excluded 32 internal planning/research, private-benchmark and artwork
files. Existing license texts, attribution and source-origin comments remain.

## Changes

- Repository, security-report, installer and VM source-offer URLs target
  `JackCaow/zapagent`. The standalone VM's historical workflows remain inert
  under `zapvm/.github/`; active workflows are at the root.
- README describes source-only availability and the actual first-run environment
  contract. `.env.example` uses placeholders; Python caches are ignored.
- Personal machine paths in retained docs/test fixtures use an example username.
- The public runtime benchmark now pins this repository's initial commit rather
  than an inaccessible commit from the previous private history.
- Only the npm-pack dry-run test and 12,000-file retrieval test receive explicit
  30-second timeouts. Runtime deadlines and other test limits are unchanged.

## Local verification

Platform: macOS arm64, Bun 1.3.14. Test state uses disposable
`ZAPCODE_DATA_DIR` directories; no live-provider benchmark was run.

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | Passed |
| `bun run typecheck`, `bun run typecheck:npm` | Passed |
| Final `bun test --reporter dot` | 4462 passed; 17 skipped; 0 failed |
| Package metadata tests after README changes | 16 passed |
| Large-directory ripgrep suite after timeout adjustment | 14 passed |
| `bun run build`, compiled `dist/zap --help` | Passed |
| `bun run check:vm` | Repository baseline, Go tests and vet passed |
| Root workflow actionlint 1.7.12, `sh -n install.sh` | Passed |
| Gitleaks 8.24.3 on the staged export | No findings (12.84 MB scanned) |
| Root `bun audit --audit-level=high` | Passed threshold |
| npm/Bun local and isolated global consumer verification | All four passed on macOS arm64; executable shims, SDK imports and patched renderer checked |
| VM Web client `npm ci --ignore-scripts`, tests, typecheck, build | Passed; 29 tests in 7 files |
| VM Web client `npm audit --audit-level=high` | Passed threshold; low findings retained below |

The original baseline suite had 4,461 passes, 17 skips and one npm-pack timeout
(13.4 seconds versus its default 5-second limit). The first exported-snapshot
suite had 4,461 passes, 17 skips, one large-directory timeout (8.4 seconds versus
5 seconds), and the subsequent assertion error after fixture cleanup. The
focused retrieval suite passed after setting that test's explicit timeout. These
failed attempts are retained here rather than represented as clean runs.

The verification-only npm tarball had SHA-256
`659007eedf6073aa4d4b8785ffaca2643fb5c192c1cd4f99b72602d00d5b504a`.
It predates the last README/report edits and is not approved for publication.
Build and verify a new exact artifact after publication gates are resolved.

The final full suite completed successfully: Ran 4479 tests across 380 files. [151.43s]

## Remaining findings

- Current prompt/implementation origins need the review recorded in
  [source-provenance-review.md](../source-provenance-review.md). A fresh Git
  history does not establish redistribution rights.
- The actual npm consumer tree reports **4 moderate entries**, all from
  `sprintf-js` through argparse/Mammoth and the consuming package:
  [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
  The audit reports no available fix and no high/critical findings. Root Bun
  audit output is not a substitute for this consumer-tree evidence.
- The optional VM Web client reports **3 low entries**, from KaTeX through
  Mermaid/Streamdown:
  [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7).
  No forced dependency upgrade or audit suppression was applied.
- Hosted CI is separate from these local results. The new repository's
  [initial CI run](https://github.com/JackCaow/zapagent/actions/runs/39232916590)
  and its npm/VM workflows did not start: GitHub explicitly reports that the
  account's Actions budget prevents execution. These are not executed test
  failures and do not supply hosted acceptance evidence.
- New-repository signing keys, vulnerability reporting, branch protections,
  real Windows/Linux acceptance and release-asset license inventories remain
  publication/release gates in [open-source-readiness.md](../open-source-readiness.md).

No repository visibility change, npm publication or binary/image release was
performed. A redacted secret scan cannot prove that all private information or
all source-origin issues have been identified.
