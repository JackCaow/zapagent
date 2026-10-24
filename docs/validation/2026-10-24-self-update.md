# Self-update validation

Scope: nonblocking startup checks, `/update` confirmation/install/restart, and
`zap update [--yes|-y]`. Candidate built from `codex/startup-update-notice`.

## Automated checks

- `bun run typecheck`: passed.
- `bun run typecheck:npm`: passed.
- Full `bun test` with disposable `ZAPCODE_DATA_DIR`: 4,600 passed, 17 skipped,
  0 failed (397 files).
- Focused checker, installer, command, lifecycle, notice, npm launcher and package
  metadata tests: 59 passed. Includes a real subprocess with non-TTY input.
- Independent agent review: passed after addressing restore error handling,
  restore-time input/queue gating and old runtime cleanup before restart.

## macOS arm64 tmux acceptance

Used an isolated workspace, data/cache directories and a loopback release server.
A synthetic `999.0.0` cache entry exercises the update path; the server returns
this branch's compiled candidate and matching SHA-256 metadata. This tests the
mechanism, not publication of a real newer version. No user installation or model
credentials were changed.

- Startup shows a notice while the prompt remains usable.
- Opening `/update`, pressing Enter, or cancelling with Escape does not download.
  Installation requires an explicit `y`.
- An HTTP 503 leaves the current TUI/session running and shows failure.
- A successful download verifies its checksum and atomically replaces the
  standalone executable.
- POSIX restart uses `execve`: observed PID 98320 before and after replacement.
  Session restore begin/end events appeared in the new log, and `/help` worked
  after restart.
- Native `zap update` queried the public npm registry and correctly reported
  installed version 1.14.8 up to date. Unknown arguments returned usage/exit 2.

Logs and captures were retained in `/tmp/zap-self-update-e2e/`; test server and
owned tmux sessions were stopped after validation.

## Acceptance boundaries

No release or production npm upgrade was performed. npm prefix/version/error
handling is covered by isolated tests; global npm updates on Windows and Linux
were not exercised on real hosts here. Automatic installation supports global
npm and macOS/Linux standalone binaries. Other installation methods explain how
to update through their package manager instead of rewriting managed files.
