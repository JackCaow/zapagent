# External delegate sandbox acceptance — 2026-10-24

## Scope and fixes

Verified on macOS Apple Silicon with zapAgent 1.14.7 plus the local sandbox fixes, Codex 0.164.0, and Claude Code 2.1.310. The parent agent used the existing StringInk connection. Test projects and application state were disposable; no credentials are included in this report.

- Codex stores sessions, SQLite databases and caches in private per-workspace CODEX_HOME; host auth/config remain read-only bridges.
- Both providers receive the macOS Keychain/MDS read access and single MDS lock needed for authentication or native TLS.
- Official provider domains are added only to the approved delegate's command-owned proxy. Explicit user denials remain effective; ordinary shells do not inherit the domains.
- Approved external delegation receives explicit Git integration grants. Linked worktrees can write their own Git metadata and shared objects/refs/logs, without writing shared config/hooks. Ordinary shells still cannot write the root .git; .zapcode stays protected.
- TMPPREFIX fixes zsh heredocs. Results clarify that per-call temporary files are cleaned up when the CLI exits, while session state persists.
- Codex disables login shells so shell startup cannot reset the broker PATH and bypass Apple toolchain shims. Private XDG config prevents implicit host Git configuration probes.
- Structured Codex failures are retained in delegate diagnostics.

## Automated verification and independent review

- Full suite in a fresh isolated ZAPCODE_DATA_DIR: **4561 passed, 17 skipped, 0 failed**, across 392 files.
- Focused delegate/parser/proxy/sandbox regression suite: **53 passed, 0 failed**.
- Tool schema budget and environment policy tests: **15 passed, 0 failed**.
- TypeScript checking, native build and git diff whitespace checks passed.
- Independent agent review passed, including actual macOS sandbox tests for standalone/linked Git commits and merges, private state/resume, heredoc, host credentials/control-plane protection, command-scoped domains and deny precedence. Login-shell and XDG changes received follow-up review.
- Linux/Windows policy tests were included in the suite; this report does not claim real-platform external CLI acceptance on those systems.

## Real tmux development acceptance

Both providers completed an initial implementation, a resumed case-sensitive extension, then a final resumed countNames extension. Work included actual registry HTTP 200, installation of picocolors 1.1.1 (npm install and npm ci), code edits, node:test regressions, shell heredocs over 10000 bytes, git add/commit, feature branches and non-fast-forward merges back to main. All work stayed local.

| Final independent check | Codex | Claude Code |
| --- | --- | --- |
| npm test | 16 passed / 0 failed | 18 passed / 0 failed |
| branch and working tree | main, clean | main, clean |
| final merge | 75378d5aca6278d7472bae999444ef2c482162fc | 9e9ba516ff87e4bf93646a39802c8cab0ff7c16b |
| merge parent count | 2 | 2 |
| delegate tool failure | 0 | 0 |
| final-round tool failures (including parent checks) | 0 | 0 |
| final-round sandbox/network refusal or cache permission warning | 0 | 0 |
| broker sandbox mode | required | required |
| observed launcher processes / sandboxed processes | 3 / 3 | 3 / 3 |

The final round ran in tmux sessions zap-final-codex and zap-final-claude, both exited 0. Native Codex shell probes additionally confirmed a non-login shell, private Git shim resolution, and no Git cache/global-ignore permission warning.

Earlier diagnostic rounds deliberately denied parent Bash calls and attempted to reread a previous invocation's removed TMPDIR file; those were expected policy/cleanup results, not remaining sandbox compatibility failures. The final round allowed read-only parent verification and had zero tool failures.

Evidence is stored locally under the disposable zapagent-delegate-fixed-20261024 directory: codex-final.jsonl, claude-final.jsonl, final-independent-verification.json and the independent npm test logs. The adjacent private-state directory contains authentication configuration and must not be shared or committed.

## Local installation

The user's npm launcher points to the verified local native build. The version remains 1.14.7 (local fix build); no public package or release was published. The original published binary and checksum were backed up before replacement. A local-build.json receipt beside the installed native binary records its checksum and source branch.
