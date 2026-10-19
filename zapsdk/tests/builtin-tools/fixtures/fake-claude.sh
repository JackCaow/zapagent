#!/bin/sh
# Test helper. If ZAPCODE_DELEGATE_FAKE_FIXTURE is set, ignore CLI args and
# stream that fixture; exit code from ZAPCODE_DELEGATE_FAKE_EXIT (default 0).
# Per-line sleep is intentionally generous (~50ms) so abort/timeout tests
# have a wide window to interrupt without races on fast machines.
fixture="${ZAPCODE_DELEGATE_FAKE_FIXTURE:-}"
exit_code="${ZAPCODE_DELEGATE_FAKE_EXIT:-0}"
delay="${ZAPCODE_DELEGATE_FAKE_DELAY:-0.05}"
if [ -z "$fixture" ] || [ ! -f "$fixture" ]; then
  echo "fake-claude: ZAPCODE_DELEGATE_FAKE_FIXTURE not set or missing" >&2
  exit 2
fi
while IFS= read -r line; do
  printf '%s\n' "$line"
  sleep "$delay" 2>/dev/null || true
done < "$fixture"
[ "$exit_code" != "0" ] && echo "fake-claude: exiting non-zero" >&2
exit "$exit_code"
