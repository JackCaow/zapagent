#!/usr/bin/env bash
# Tmux-driven verification for the ApprovalBar scrollback bug.
#
# Strategy:
#   1. Spawn a tmux session with a known viewport size.
#   2. Run the harness — it builds transcript pressure, mounts ApprovalBar,
#      streams chunks while the dialog is up, programmatically picks "1",
#      then exits.
#   3. Capture the full pane buffer (visible + scrollback) via capture-pane.
#   4. Assert the dialog body ("Approve?") does NOT appear anywhere — the
#      ONLY place it should have lived is the live-rendered region, which
#      Ink's eraseLines should have wiped on dismissal.
#
# Exit codes: 0 = pass (dialog gone), 1 = fail (dialog leaked into scrollback).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS="$ROOT/tests/manual/approval-scrollback-harness.tsx"
SESSION="approval-verify-$$"
PANE_DUMP="/tmp/${SESSION}.dump"

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$PANE_DUMP"
}
trap cleanup EXIT

# Small viewport amplifies the bug — fewer rows means dynamic frame
# bottoms out faster, OS-scroll-on-output kicks in sooner.
tmux new-session -d -s "$SESSION" -x 120 -y 30
tmux send-keys -t "$SESSION" "cd '$ROOT' && bun run '$HARNESS'; echo HARNESS_DONE" Enter

# Poll the FULL buffer (visible + scrollback). Match on `transcript-line-40`
# (the last seeded transcript line — only the harness can produce it) AND
# the post-`HARNESS_DONE` shell prompt. Naive `grep HARNESS_DONE` matches
# the command text tmux echoes back BEFORE bun even starts.
for _ in $(seq 1 60); do
  tmux capture-pane -t "$SESSION" -p -S - > "$PANE_DUMP" 2>/dev/null || true
  if grep -q "transcript-line-40" "$PANE_DUMP" \
     && grep -q "post-dismiss-marker" "$PANE_DUMP" \
     && grep -c "HARNESS_DONE" "$PANE_DUMP" | grep -qv "^1$"; then
    break
  fi
  sleep 0.2
done

if ! grep -q "post-dismiss-marker" "$PANE_DUMP"; then
  echo "FAIL: harness did not finish (no post-dismiss-marker) — check $PANE_DUMP"
  tail -40 "$PANE_DUMP" 2>/dev/null
  exit 1
fi

# Body marker — present only inside the live ApprovalBar.
if grep -q "Approve?" "$PANE_DUMP"; then
  echo "FAIL: ApprovalBar leaked into scrollback"
  echo "---- pane buffer ----"
  cat "$PANE_DUMP"
  exit 1
fi

# Sanity: transcript content survived (we should still see streaming
# chunks). If not, the harness didn't run far enough to expose the bug.
if ! grep -q "streaming-chunk" "$PANE_DUMP"; then
  echo "FAIL: harness didn't stream — test inconclusive"
  cat "$PANE_DUMP"
  exit 1
fi

# Sanity: dismiss marker reached (programmatic onChoose fired).
if ! grep -q "post-dismiss-marker" "$PANE_DUMP"; then
  echo "FAIL: dialog never dismissed — test inconclusive"
  cat "$PANE_DUMP"
  exit 1
fi

echo "PASS: ApprovalBar dismissed cleanly, no scrollback leak"
