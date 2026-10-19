# Open-source preparation — 2026-10-19

The candidate is a source export with fresh Git history. Local verification is
in progress; no hosted or cross-platform acceptance is claimed.

Initial baseline checks: frozen Bun install, root and npm-tooling typechecks,
and `bun audit --audit-level=high` passed on macOS arm64 with Bun 1.3.14.
Gitleaks 8.24.3 scanned 1,516 commits across the original repository's local refs
and reported no findings. That scan does not replace scanning this final export.

The baseline default-timeout Bun suite hit the known package dry-run timeout
(13.4 seconds against a 5-second limit). The candidate gives only that packaging
test a 30-second timeout; other tests retain their existing limits.

The new repository has no binary or npm release. The paid private-repository
cache benchmark was not rerun and its old acceptance report is not exported.
