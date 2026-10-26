# Root Git writes and approval lifetime

## Changes

Ordinary shell processes retain read-only Git metadata. The local CLI opts into
an adapter for strictly parsed, standalone `git add`, `git commit -m`,
`git stash push/pop` and fresh noninteractive `git rebase <ref>`. The adapter
launches trusted system Git directly inside its own OS sandbox, with validated
repository/worktree metadata writable only for that process. Hooks, fsmonitor,
signing and editors are disabled. Executable/unknown local configuration,
includes, existing rebase/sequencer state, compound shell syntax and unsupported
options retain the original sandbox path. No automatic sandbox escape is added.
GitLab CLI `remote.<name>.glab-resolved-head` metadata is inert and accepted.

Default policy grants now activate their execution lifetime after affirmative
approval and lifecycle handling, excluding human and shared-queue wait. Custom
absolute expiries, task deadlines, denial and cancellation retain their limits.

## Verification

- Independent agent review passed, including the final GitLab metadata change.
- App TypeScript check and `git diff --check` passed.
- Main full-suite rerun: `bun test --timeout 20000`, 4,614 passed, 17 skipped,
  0 failed (398 files). The first run at the default five-second timeout had
  load-related failures while Xcode/iOS simulator services were busy. No test
  assertions were relaxed; the two old evaluation suites also passed isolated
  rerun, 14/14.
- Final focused checks after the GitLab compatibility addition: 61 passed,
  0 failed across seven files. Covers delayed/queued approval, scheduling expiry,
  custom absolute expiry, cancellation/deadline, root and linked worktrees,
  ordinary-shell metadata link denial, hooks/fake-PATH attacks and unsafe config.
- Read-only eligibility check of the reported `token-hub` repository passed;
  that repository's files, refs and stash were not changed.

## tmux and local installation

The interactive shell resolves `zap` to the npm launcher at
`/Users/cver/.npm-global/bin/zap`. Its native cache was updated to the reviewed
local build (version string remains 1.14.9; this is not a new public release).
The original binary and checksum are preserved under
`~/.cache/zapagent/local-backups/2026-10-26-git-sandbox/`.

1. `zap-git-fix-real` ran the installed CLI using the existing default model
   (`deepseek-v4.1-flash`) in a disposable repository, with sandbox escapes
   explicitly disabled. All five Git writes succeeded. Runtime receipts report
   one spawned and one sandboxed process for each operation. The task recovered
   from an unrelated BSD `cat -A` option error. Its final `ok` was true.
2. After the final compatibility change, `zap-git-final-artifact` ran the final
   installed binary with a deterministic loopback model fixture. The repository
   included the GitLab metadata. CLI exit code was 0; add, commit, stash push,
   stash pop and rebase each succeeded with 1/1 sandboxed process receipts.
3. Host-side checks confirmed `HEAD^ == main`, clean porcelain output, empty
   stash and matching SHA-256 for the installed binary and compiled candidate.

Evidence: `/tmp/zap-git-fix-tmux/git-proof.json` and
`/tmp/zap-git-final-tmux/proof.json`. The temporary copy of real model credentials
was deleted after the real-provider run. No user repository was used for writes.

Real OS execution evidence is macOS arm64. Windows/Linux policy construction is
covered by tests, but this change was not exercised on real Windows/Linux hosts.
