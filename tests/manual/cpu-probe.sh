#!/usr/bin/env bash
# Probe CPU usage around /model dialog open + nav.
#
# Spawns zapcode in a tmux session with ZAPCODE_DIAG=1 + render sentinel.
# Samples ps -o pcpu over four phases (BASELINE / DIALOG / NAV / AFTER) and
# tails the per-phase diag lines from ~/.zapcode/logs/latest.log.
#
# Run from repo root:
#   bash tests/manual/cpu-probe.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SESSION="zap-cpu-probe-$$"
LOG_DIR="${HOME}/.zapcode/logs"
LINE_FILE="$(mktemp -t zap-cpu-probe.XXXXXX)"
echo 0 > "$LINE_FILE"

# Optional flags forwarded into the bun environment.
EXTRA_ENV=""
case "${1:-}" in
  --no-takeover)
    EXTRA_ENV="ZAPCODE_NO_MODAL_TAKEOVER=1"
    echo "(takeover OFF — slot mode)"
    ;;
  "")
    ;;
  *)
    echo "usage: $0 [--no-takeover]" >&2
    exit 2
    ;;
esac

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$LINE_FILE"
}
trap cleanup EXIT

# Spawn zapcode in a 120x40 pane. exec so pane_pid IS bun.
tmux new-session -d -s "$SESSION" -x 120 -y 40 \
  "cd '$REPO_ROOT' && ZAPCODE_DIAG=1 ZAPCODE_RENDER_SENTINEL=1 $EXTRA_ENV exec bun run src/index.tsx 2> /tmp/zap-cpu-probe.stderr"

# Wait up to 8s for boot — look for the prompt arrow.
for _ in $(seq 1 80); do
  pane="$(tmux capture-pane -p -t "$SESSION" 2>/dev/null || true)"
  if echo "$pane" | grep -q '❯'; then
    break
  fi
  sleep 0.1
done

PANE_PID="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
BUN_PID="$PANE_PID"
if ! ps -p "$BUN_PID" -o comm= 2>/dev/null | grep -q bun; then
  CHILD="$(pgrep -P "$BUN_PID" -n bun 2>/dev/null || true)"
  [[ -n "$CHILD" ]] && BUN_PID="$CHILD"
fi

LATEST_LOG="$(readlink -f "$LOG_DIR/latest.log" 2>/dev/null || readlink "$LOG_DIR/latest.log" 2>/dev/null || echo "")"
echo "session=$SESSION pane_pid=$PANE_PID bun_pid=$BUN_PID"
echo "latest_log=$LATEST_LOG"
[[ -n "$LATEST_LOG" && -f "$LATEST_LOG" ]] && wc -l < "$LATEST_LOG" | tr -d ' \n' > "$LINE_FILE"
echo

sample_phase() {
  local label="$1" duration="$2"
  local before_lines
  before_lines="$(cat "$LINE_FILE")"
  local samples=()
  local end=$(( $(date +%s) + duration ))
  while [[ $(date +%s) -lt $end ]]; do
    local pcpu
    pcpu="$(ps -p "$BUN_PID" -o pcpu= 2>/dev/null | tr -d ' ')"
    [[ -z "$pcpu" ]] && pcpu="?"
    samples+=("$pcpu")
    sleep 0.5
  done
  printf '%-9s pcpu=[%s]\n' "$label" "$(IFS=,; echo "${samples[*]}")"
  if [[ -n "$LATEST_LOG" && -f "$LATEST_LOG" ]]; then
    local now_lines
    now_lines="$(wc -l < "$LATEST_LOG" | tr -d ' ')"
    local delta=$(( now_lines - before_lines ))
    printf '%-9s diag_lines+=%d\n' "$label" "$delta"
    if [[ $delta -gt 0 ]]; then
      tail -n "$delta" "$LATEST_LOG" | \
        grep -E '"(spinner_tick_rate|spinner_status|app_render_rate|dialog_state|picker_render|picker_input)"' | \
        tail -n 16 | sed 's/^/    /'
    fi
    echo "$now_lines" > "$LINE_FILE"
  fi
}

echo "=== Phase 1: BASELINE (idle prompt) ==="
sample_phase BASELINE 3

echo
echo "=== Phase 2: DIALOG (just opened /model) ==="
# Two send-keys calls — combining "/model" with Enter sometimes coalesces
# under bracketed-paste mode and the literal '/' gets eaten as a meta key
# binding by Ink; separate keystrokes match how a human types it.
tmux send-keys -t "$SESSION" "/model"
sleep 0.3
tmux send-keys -t "$SESSION" Enter
sleep 0.6
sample_phase DIALOG 3

echo
echo "=== Phase 3: NAV (arrow keys) ==="
for _ in 1 2 3 4 5 6 7 8; do
  tmux send-keys -t "$SESSION" Down
  sleep 0.1
done
sample_phase NAV 3

echo
echo "=== Phase 4: AFTER (Esc, idle prompt) ==="
tmux send-keys -t "$SESSION" Escape
sleep 0.5
sample_phase AFTER 3

echo
echo "=== Final pane snapshot ==="
tmux capture-pane -p -t "$SESSION" -S -10 -E - 2>/dev/null | sed 's/^/    /'

echo
echo "=== Trailing diag log (last 40 matching events) ==="
if [[ -n "$LATEST_LOG" && -f "$LATEST_LOG" ]]; then
  grep -E '"(spinner_tick_rate|spinner_status|app_render_rate|dialog_state|picker_render|picker_input)"' "$LATEST_LOG" | tail -n 60 | sed 's/^/    /'
fi

if [[ -s /tmp/zap-cpu-probe.stderr ]]; then
  echo
  echo "=== stderr (render-storm hits etc.) ==="
  tail -n 30 /tmp/zap-cpu-probe.stderr | sed 's/^/    /'
fi
