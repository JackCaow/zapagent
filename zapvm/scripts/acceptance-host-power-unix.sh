#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
    echo "usage: $0 ZAPVM IMAGE_ROOT IMAGE_PUBLIC_KEY WORKSPACE EVIDENCE_DIRECTORY" >&2
    exit 2
fi

zapvm=$1
image_root=$2
image_public_key=$3
workspace=$4
evidence_dir=$5
platform=$(uname -s)
case "$platform" in
    Darwin|Linux) ;;
    *) echo "this Host power acceptance supports only macOS and Linux" >&2; exit 2 ;;
esac
for path in "$zapvm" "$image_root" "$image_public_key" "$workspace" "$evidence_dir"; do
    case "$path" in
        /*) ;;
        *) echo "all paths must be absolute: $path" >&2; exit 2 ;;
    esac
done
test -x "$zapvm" || { echo "missing executable zapvm: $zapvm" >&2; exit 1; }
test -d "$image_root" || { echo "missing image root: $image_root" >&2; exit 1; }
test -f "$image_public_key" || { echo "missing image public key: $image_public_key" >&2; exit 1; }
test -d "$workspace" || { echo "missing workspace: $workspace" >&2; exit 1; }
if [ -e "$evidence_dir" ]; then
    echo "refusing existing evidence directory: $evidence_dir" >&2
    exit 2
fi

wake_seconds=${ZAPVM_POWER_WAKE_SECONDS:-45}
case "$wake_seconds" in
    *[!0-9]*|'') echo "ZAPVM_POWER_WAKE_SECONDS must be an integer" >&2; exit 2 ;;
esac
if [ "$wake_seconds" -lt 30 ] || [ "$wake_seconds" -gt 300 ]; then
    echo "ZAPVM_POWER_WAKE_SECONDS must be between 30 and 300" >&2
    exit 2
fi
command -v sudo >/dev/null 2>&1 || { echo "sudo is required" >&2; exit 1; }
if [ "$platform" = Linux ]; then
    rtcwake_path=$(command -v rtcwake 2>/dev/null || true)
    systemctl_path=$(command -v systemctl 2>/dev/null || true)
    test -n "$rtcwake_path" || { echo "rtcwake is required" >&2; exit 1; }
    test -n "$systemctl_path" || { echo "systemctl is required" >&2; exit 1; }
    sudo -n -l "$rtcwake_path" -m no -s "$wake_seconds" >/dev/null 2>&1 || {
        echo "configure narrow NOPASSWD sudo for: $rtcwake_path -m no -s $wake_seconds" >&2
        exit 1
    }
    sudo -n -l "$systemctl_path" suspend >/dev/null 2>&1 || {
        echo "configure narrow NOPASSWD sudo for: $systemctl_path suspend" >&2
        exit 1
    }
else
    pmset_path=$(command -v pmset 2>/dev/null || true)
    test -n "$pmset_path" || { echo "pmset is required" >&2; exit 1; }
    sudo -n -l "$pmset_path" relative wake "$wake_seconds" >/dev/null 2>&1 || {
        echo "configure narrow NOPASSWD sudo for: $pmset_path relative wake $wake_seconds" >&2
        exit 1
    }
    sudo -n -l "$pmset_path" sleepnow >/dev/null 2>&1 || {
        echo "configure narrow NOPASSWD sudo for: $pmset_path sleepnow" >&2
        exit 1
    }
fi

mkdir -p "$evidence_dir/state"
endpoint="$evidence_dir/daemon.sock"
daemon_stdout="$evidence_dir/daemon.stdout"
daemon_stderr="$evidence_dir/daemon.stderr"
active_stdout="$evidence_dir/active.stdout"
active_stderr="$evidence_dir/active.stderr"
daemon_pid=
active_pid=

cleanup() {
    if [ -n "$active_pid" ] && kill -0 "$active_pid" 2>/dev/null; then
        kill "$active_pid" 2>/dev/null || true
        wait "$active_pid" 2>/dev/null || true
    fi
    if [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null; then
        "$zapvm" daemon stop --endpoint "$endpoint" >/dev/null 2>&1 || true
        wait "$daemon_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT HUP INT TERM

host_boot_id() {
    if [ "$platform" = Linux ]; then
        cat /proc/sys/kernel/random/boot_id
    else
        sysctl -n kern.boottime
    fi
}

"$zapvm" daemon serve \
    --endpoint "$endpoint" \
    --image-root "$image_root" \
    --image-public-key "$image_public_key" \
    --state-root "$evidence_dir/state" \
    --max-workers 1 \
    --max-per-workspace 1 \
    --idle-timeout 30m \
    --stop-timeout 45s \
    --cpus 2 \
    --memory-mib 1024 >"$daemon_stdout" 2>"$daemon_stderr" &
daemon_pid=$!

ready=false
attempt=0
while [ "$attempt" -lt 300 ]; do
    if ! kill -0 "$daemon_pid" 2>/dev/null; then
        wait "$daemon_pid" || true
        echo "daemon exited before readiness; see $daemon_stderr" >&2
        exit 1
    fi
    if "$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-initial.json" 2>/dev/null; then
        ready=true
        break
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done
if [ "$ready" != true ]; then
    echo "daemon did not become ready" >&2
    exit 1
fi

before_output=$("$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" \
    --session-id host-power --exec-timeout 2m -- /bin/sh -c '
        set -eu
        cat /proc/sys/kernel/random/boot_id
        printf "%s\n" POWER_STATE_MARKER >/var/lib/zapvm/data/power-marker
        printf "%s\n" POWER_SESSION_MARKER >"$HOME/power-marker"
        echo POWER_BEFORE_SLEEP_OK
    ')
printf '%s\n' "$before_output" >"$evidence_dir/exec-before-sleep.log"
guest_boot_before=$(printf '%s\n' "$before_output" | sed -n '1p')
test -n "$guest_boot_before"
printf '%s\n' "$before_output" | grep -qx POWER_BEFORE_SLEEP_OK

rm -f "$workspace/power-active-started" "$workspace/power-host-resumed"
"$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" \
    --session-id host-power --exec-timeout 10m -- /bin/sh -c '
        set -eu
        printf "%s\n" ready >power-active-started
        while [ ! -f power-host-resumed ]; do sleep 0.2; done
        echo POWER_ACTIVE_RESUMED_OK
    ' >"$active_stdout" 2>"$active_stderr" &
active_pid=$!
attempt=0
while [ "$attempt" -lt 300 ] && [ ! -f "$workspace/power-active-started" ]; do
    if ! kill -0 "$active_pid" 2>/dev/null; then
        wait "$active_pid" || true
        echo "active command exited before Host sleep" >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done
test -f "$workspace/power-active-started" || { echo "active command marker timeout" >&2; exit 1; }
"$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-active-before-sleep.json"
grep -q '"leases":1' "$evidence_dir/status-active-before-sleep.json"

host_boot_before=$(host_boot_id)
printf '%s\n' "$host_boot_before" >"$evidence_dir/host-boot-before.txt"
sleep_started=$(date +%s)
printf '%s\n' "$sleep_started" >"$evidence_dir/sleep-start-epoch.txt"
if [ "$platform" = Linux ]; then
    sudo -n "$rtcwake_path" -m no -s "$wake_seconds" >"$evidence_dir/wake-schedule.log" 2>&1
    sudo -n "$systemctl_path" suspend
else
    wake_at=$(date -v+"${wake_seconds}"S '+%m/%d/%y %H:%M:%S')
    sudo -n "$pmset_path" relative wake "$wake_seconds" >"$evidence_dir/wake-schedule.log" 2>&1
    printf 'wake_at=%s\n' "$wake_at" >>"$evidence_dir/wake-schedule.log"
    sudo -n "$pmset_path" sleepnow
fi
sleep_finished=$(date +%s)
printf '%s\n' "$sleep_finished" >"$evidence_dir/sleep-finish-epoch.txt"
elapsed=$((sleep_finished - sleep_started))
if [ "$elapsed" -lt 5 ]; then
    echo "Host suspend command returned too quickly (${elapsed}s)" >&2
    exit 1
fi

resumed=false
attempt=0
while [ "$attempt" -lt 600 ]; do
    if grep -q 'zapVM daemon Host resume completed' "$daemon_stderr" 2>/dev/null &&
        "$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-after-wake.json" 2>/dev/null; then
        resumed=true
        break
    fi
    attempt=$((attempt + 1))
    sleep 0.2
done
if [ "$resumed" != true ]; then
    echo "daemon did not confirm Host resume" >&2
    exit 1
fi
grep -q 'zapVM daemon Host suspend completed ownership=true' "$daemon_stderr"
host_boot_after=$(host_boot_id)
printf '%s\n' "$host_boot_after" >"$evidence_dir/host-boot-after.txt"
test "$host_boot_after" = "$host_boot_before" || { echo "Host rebooted instead of resuming" >&2; exit 1; }

printf '%s\n' resumed >"$workspace/power-host-resumed"
if ! wait "$active_pid"; then
    active_pid=
    echo "active command failed after Host resume; see $active_stderr" >&2
    exit 1
fi
active_pid=
grep -qx POWER_ACTIVE_RESUMED_OK "$active_stdout"

after_output=$("$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" \
    --session-id host-power --exec-timeout 2m -- /bin/sh -c '
        set -eu
        cat /proc/sys/kernel/random/boot_id
        test "$(cat /var/lib/zapvm/data/power-marker)" = POWER_STATE_MARKER
        test "$(cat "$HOME/power-marker")" = POWER_SESSION_MARKER
        echo POWER_AFTER_WAKE_OK
    ')
printf '%s\n' "$after_output" >"$evidence_dir/exec-after-wake.log"
guest_boot_after=$(printf '%s\n' "$after_output" | sed -n '1p')
test "$guest_boot_after" = "$guest_boot_before" || { echo "guest rebooted across Host sleep" >&2; exit 1; }
printf '%s\n' "$after_output" | grep -qx POWER_AFTER_WAKE_OK

if [ "$platform" = Linux ]; then
    journalctl --since "@$sleep_started" --no-pager >"$evidence_dir/host-power.log" 2>&1 || true
else
    pmset -g log | tail -n 1000 >"$evidence_dir/host-power.log" 2>&1 || true
fi

"$zapvm" daemon stop --endpoint "$endpoint"
wait "$daemon_pid"
daemon_pid=
state_count=0
for state_disk in "$evidence_dir"/state/*.raw; do
    test -f "$state_disk" || continue
    state_count=$((state_count + 1))
    state_json="$evidence_dir/state-$(basename "$state_disk" .raw).json"
    "$zapvm" state inspect --disk "$state_disk" >"$state_json"
    grep -q '"clean_shutdown": true' "$state_json"
done
test "$state_count" -ge 1 || { echo "no daemon state disk was created" >&2; exit 1; }
test ! -e "$endpoint" || { echo "daemon endpoint remains after stop" >&2; exit 1; }

cat >"$evidence_dir/assertions.json" <<EOF
{
  "schema_version": 1,
  "platform": "$platform",
  "host_suspend_elapsed_seconds": $elapsed,
  "guest_boot_id": "$guest_boot_before",
  "active_command_resumed": true,
  "state_and_session_preserved": true,
  "clean_shutdown": true,
  "state_count": $state_count
}
EOF
trap - EXIT HUP INT TERM
printf 'HOST_POWER_ACCEPTANCE_OK platform=%s evidence=%s\n' "$platform" "$evidence_dir"
