# Context window and compact integration

Date: 2026-10-27

Custom connections can associate an endpoint model alias with an explicit
models.dev provider/model entry, or set a manual context window. Linking metadata
does not change the endpoint, credentials, protocol, or wire model ID. Manual
limits take precedence over catalog refreshes; unknown metadata remains visible.

TUI, manual `/compact`, SDK Loop, and headless runs share compaction planning,
request accounting, bounded summaries/repair, and candidate validation. The
current request and active tool group stay intact. Cancellation, invalid output,
and revision conflicts do not replace history. `auto=false` disables proactive
compaction, including descendants, while manual and bounded emergency recovery
remain available. Prune is explicitly shown as inactive in this phase.

## Terminal evidence

[Controlled tmux snapshot replay](2026-10-27-context-window-compact.cast)
(asciinema v2; `asciinema play` can replay it). These are snapshots of actual
compiled CLI sessions using disposable data and local fixtures, not a recording
of personal sessions or a live upstream model benchmark.

The provider onboarding fixture verifies alias linkage to a 1,048,576-token
catalog entry, automatic limits, a 262,144-token manual override, persisted
configuration, and unchanged endpoint/model identity. The compaction fixture
verifies the marker and subsequent answers remain visible after replacing Ink's
Static transcript, and that a cancelled summary is absent from the next request.

## Verification

```sh
bun run typecheck
bun test --timeout 20000
bun run build
RUN_TUI_PTY_TESTS=1 ZAP_TEST_COMPILED_BINARY="$PWD/dist/zap" \
  bun test tests/ui/compact.pty.test.ts tests/ui/provider-onboarding.pty.test.ts --timeout 90000
```

The full suite passed with 4,665 tests, 18 skipped, and 0 failures across 402
files (17,711 assertions). Typechecking and compilation passed. The two
compiled TUI tests passed (45 assertions). The local HTTP acceptance
matrix also completed with exit code 0:

- Shared SDK exact boundary: window 1,048,576, reserve 8,192, effective input
  1,039,384, proactive threshold 831,507, soft target 415,753. Equality does not
  trigger; threshold + 1 does.
- Compiled headless CLI: 800K synthetic history does not compact; 840K history
  compacts with auto enabled (complete request estimate 860,129), and does not
  proactively compact with auto disabled. Each run executes a real `read_file`
  and returns its result to the mock provider with the current user constraint.
- TUI shows a 1.05M window, 831.5K threshold, auto off, and prune not active.
  Manual compact succeeds; double-Esc cancellation preserves the committed
  summary and earlier history; a subsequent request completes.

The exact SDK boundary is a planner check; the CLI cases exercise real compiled
request paths against a local mock. They do not establish upstream 1M capacity.

Independent agent and Claude Code reviews passed for phase one and the transcript
fix. An additional integration review passed for the combined provider/context
and compact paths, including 60 targeted tests, typechecking, and staged diff
checks. Review scope includes metadata resolution into active runtime/manual
compact budgets and saving model configuration without stale limits.
