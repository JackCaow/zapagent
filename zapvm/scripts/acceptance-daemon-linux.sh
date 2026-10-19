#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
    echo "usage: acceptance-daemon-linux.sh ZAPVM IMAGE_ROOT PUBLIC_KEY WORKSPACE EVIDENCE_DIR" >&2
    exit 2
fi
zapvm=$1
image_root=$2
image_public_key=$3
workspace=$4
evidence_dir=$5

host_os=$(uname -s)
case "$host_os" in
    Linux|Darwin) ;;
    *) echo "daemon acceptance must run on Linux or macOS" >&2; exit 2 ;;
esac
for path in "$zapvm" "$image_root" "$image_public_key" "$workspace" "$evidence_dir"; do
    case "$path" in
        /*) ;;
        *) echo "daemon acceptance paths must be absolute: $path" >&2; exit 2 ;;
    esac
done
test -x "$zapvm" || { echo "zapvm is not executable: $zapvm" >&2; exit 1; }
test -d "$image_root" || { echo "missing image root: $image_root" >&2; exit 1; }
test -f "$image_public_key" || { echo "missing image public key: $image_public_key" >&2; exit 1; }
test -d "$workspace" || { echo "missing workspace: $workspace" >&2; exit 1; }
if [ -e "$evidence_dir" ]; then
    echo "refusing existing daemon evidence directory: $evidence_dir" >&2
    exit 2
fi

mkdir -p "$evidence_dir/state"
chmod 0700 "$evidence_dir" "$evidence_dir/state"
endpoint="$evidence_dir/zapvm.sock"
endpoint_dir=
if [ "${#endpoint}" -gt 100 ]; then
    endpoint_dir=$(mktemp -d "${TMPDIR:-/tmp}/zapvm-daemon.XXXXXX")
    chmod 0700 "$endpoint_dir"
    endpoint="$endpoint_dir/zapvm.sock"
fi
credential="$evidence_dir/acceptance-token"
printf '%s\n' 'zapvm-target-host-acceptance-token' >"$credential"
chmod 0600 "$credential"
daemon_pid=
active_client_pid=
route_rw_pid=
route_ro_pid=

cleanup() {
	for client_pid in "$active_client_pid" "$route_rw_pid" "$route_ro_pid"; do
		if [ -n "$client_pid" ] && kill -0 "$client_pid" 2>/dev/null; then
			kill "$client_pid" 2>/dev/null || true
			wait "$client_pid" 2>/dev/null || true
		fi
	done
    if [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null; then
        "$zapvm" daemon stop --endpoint "$endpoint" >/dev/null 2>&1 || kill "$daemon_pid" 2>/dev/null || true
        wait "$daemon_pid" 2>/dev/null || true
    fi
    if [ -n "$endpoint_dir" ]; then
        rmdir "$endpoint_dir" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

capture_residual_processes() {
	ps -eo pid=,comm=,args= | awk -v evidence="$evidence_dir" '
		index($0, evidence) > 0 && $2 ~ /^(zapvm|cloud-hyper|virtiofsd|systemd-run)/ {
			print
			found = 1
		}
		END { exit(found ? 0 : 1) }
	'
}

"$zapvm" daemon serve \
    --endpoint "$endpoint" \
    --image-root "$image_root" \
    --image-public-key "$image_public_key" \
    --state-root "$evidence_dir/state" \
    --credential "acceptance-token=$credential" \
    --max-workers 2 \
    --max-per-workspace 2 \
    --idle-timeout 30m \
    --stop-timeout 45s \
    --cpus 2 \
    --memory-mib 1024 >"$evidence_dir/daemon.stdout.log" 2>"$evidence_dir/daemon.stderr.log" &
daemon_pid=$!

attempt=0
while [ ! -S "$endpoint" ]; do
    if ! kill -0 "$daemon_pid" 2>/dev/null; then
        wait "$daemon_pid" || true
        cat "$evidence_dir/daemon.stderr.log" >&2
        echo "daemon exited before creating its endpoint" >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 300 ]; then
        echo "daemon endpoint did not appear" >&2
        exit 1
    fi
    sleep 0.1
done

"$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-initial.json"
grep -q '"workers":0' "$evidence_dir/status-initial.json"

if ! "$zapvm" daemon exec \
    --endpoint "$endpoint" \
    --workspace "$workspace" \
    --session-id target-daemon \
    --credential-id acceptance-token \
    --exec-timeout 2m -- /bin/sh -c '
        set -eu
        cat /proc/sys/kernel/random/boot_id
        test "$(cat /run/zapvm-credentials/acceptance-token)" = zapvm-target-host-acceptance-token
        if printf x >>/run/zapvm-credentials/acceptance-token 2>/dev/null; then exit 1; fi
        printf "%s\n" DAEMON_STATE_MARKER >/var/lib/zapvm/data/daemon-marker
        printf "%s\n" DAEMON_SESSION_MARKER >"$HOME/daemon-marker"
        echo DAEMON_CREDENTIAL_READONLY_OK
    ' >"$evidence_dir/exec-before-pause.log"; then
    cat "$evidence_dir/daemon.stderr.log" >&2
    exit 1
fi
boot_before=$(sed -n '1p' "$evidence_dir/exec-before-pause.log")
test -n "$boot_before"
grep -q DAEMON_CREDENTIAL_READONLY_OK "$evidence_dir/exec-before-pause.log"

"$zapvm" daemon exec \
    --endpoint "$endpoint" \
    --workspace "$workspace" \
    --session-id target-daemon \
    --exec-timeout 2m -- /bin/sh -c '
        set -eu
        test ! -e /run/zapvm-credentials/acceptance-token
        echo DAEMON_CREDENTIAL_CLEANUP_OK
    ' >"$evidence_dir/credential-cleanup.log"
grep -q DAEMON_CREDENTIAL_CLEANUP_OK "$evidence_dir/credential-cleanup.log"

mkdir -p "$workspace/.git" "$workspace/.zapcode"
printf '%s\n' GIT_CONTROL_ORIGINAL >"$workspace/.git/protected"
printf '%s\n' ZAP_CONTROL_ORIGINAL >"$workspace/.zapcode/settings.json"
"$zapvm" daemon exec \
    --endpoint "$endpoint" --workspace "$workspace" --session-id target-daemon \
    --protect-workspace-path .git --protect-workspace-path .zapcode \
    --exec-timeout 2m -- /bin/sh -c 'printf "%s\n" WORKSPACE_WRITE_OK >ordinary-write' \
    >"$evidence_dir/protected-ordinary-write.log"
grep -q WORKSPACE_WRITE_OK "$workspace/ordinary-write"
for protected_target in .git/protected .zapcode/settings.json; do
    evidence_name=$(printf '%s' "$protected_target" | tr '/.' '__')
    if "$zapvm" daemon exec \
        --endpoint "$endpoint" --workspace "$workspace" --session-id target-daemon \
        --protect-workspace-path .git --protect-workspace-path .zapcode \
        --exec-timeout 2m -- /bin/sh -c "printf '%s\\n' TAMPERED >'$protected_target'" \
        >"$evidence_dir/protected-$evidence_name.stdout" 2>"$evidence_dir/protected-$evidence_name.stderr"; then
        echo "protected workspace write unexpectedly succeeded: $protected_target" >&2
        exit 1
    fi
done
grep -q '^GIT_CONTROL_ORIGINAL$' "$workspace/.git/protected"
grep -q '^ZAP_CONTROL_ORIGINAL$' "$workspace/.zapcode/settings.json"
printf '%s\n' PROTECTED_WORKSPACE_PATHS_OK >"$evidence_dir/protected-workspace-paths.log"

active_marker="$workspace/daemon-active-started"
test ! -e "$active_marker"
"$zapvm" daemon exec \
    --endpoint "$endpoint" \
    --workspace "$workspace" \
    --session-id target-daemon \
    --exec-timeout 2m -- /bin/sh -c '
        set -eu
        printf "%s\n" ready >daemon-active-started
        sleep 5
        echo DAEMON_ACTIVE_DRAIN_OK
    ' >"$evidence_dir/active-drain.log" 2>&1 &
active_client_pid=$!
attempt=0
while [ ! -f "$active_marker" ]; do
    if ! kill -0 "$active_client_pid" 2>/dev/null; then
        wait "$active_client_pid" || true
        cat "$evidence_dir/active-drain.log" >&2
        echo "active drain command exited before its marker" >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 300 ]; then echo "active drain marker timeout" >&2; exit 1; fi
    sleep 0.1
done
"$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-active.json"
grep -q '"leases":1' "$evidence_dir/status-active.json"
pause_started=$(date +%s)
"$zapvm" daemon pause --endpoint "$endpoint"
pause_elapsed=$(( $(date +%s) - pause_started ))
printf '%s\n' "$pause_elapsed" >"$evidence_dir/pause-drain-seconds.txt"
test "$pause_elapsed" -ge 4
wait "$active_client_pid"
grep -q DAEMON_ACTIVE_DRAIN_OK "$evidence_dir/active-drain.log"
"$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-paused.json"
grep -q '"paused":true' "$evidence_dir/status-paused.json"
grep -q '"leases":0' "$evidence_dir/status-paused.json"
if "$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" -- /bin/true \
    >"$evidence_dir/paused-exec.stdout" 2>"$evidence_dir/paused-exec.stderr"; then
    echo "paused daemon unexpectedly accepted an exec" >&2
    exit 1
fi
grep -q 'VM pool is paused' "$evidence_dir/paused-exec.stderr"
"$zapvm" daemon resume --endpoint "$endpoint"

"$zapvm" daemon exec \
    --endpoint "$endpoint" \
    --workspace "$workspace" \
    --session-id target-daemon \
    --exec-timeout 2m -- /bin/sh -c '
        set -eu
        cat /proc/sys/kernel/random/boot_id
        test "$(cat /var/lib/zapvm/data/daemon-marker)" = DAEMON_STATE_MARKER
        test "$(cat "$HOME/daemon-marker")" = DAEMON_SESSION_MARKER
        echo DAEMON_RESUME_PRESERVED_OK
    ' >"$evidence_dir/exec-after-resume.log"
boot_after=$(sed -n '1p' "$evidence_dir/exec-after-resume.log")
test "$boot_after" = "$boot_before"
grep -q DAEMON_RESUME_PRESERVED_OK "$evidence_dir/exec-after-resume.log"

if [ "${ZAPVM_DAEMON_SINGLE_VM:-0}" = 1 ]; then
    "$zapvm" daemon pause --endpoint "$endpoint"
    "$zapvm" daemon stop --endpoint "$endpoint"
    wait "$daemon_pid"
    daemon_pid=
    test ! -e "$endpoint"
    state_count=0
    for state_disk in "$evidence_dir"/state/*.raw; do
        test -f "$state_disk"
        state_count=$((state_count + 1))
        state_json="$evidence_dir/state-$(basename "$state_disk" .raw).json"
        "$zapvm" state inspect --disk "$state_disk" >"$state_json"
        grep -q '"clean_shutdown": true' "$state_json"
    done
    test "$state_count" -eq 1
    if capture_residual_processes >"$evidence_dir/process-residual.log"; then
        echo "single-VM daemon acceptance left a zapvm process" >&2
        exit 1
    fi
    rm -f "$credential"
    test ! -e "$credential"
    printf '%s\n' "boot_id=$boot_before" "pause_drain_seconds=$pause_elapsed" "state_count=$state_count" \
        >"$evidence_dir/assertions.txt"
    printf 'UNIX_DAEMON_SINGLE_VM_ACCEPTANCE_OK host=%s evidence=%s\n' "$host_os" "$evidence_dir"
    exit 0
fi

"$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" --session-id route-rw \
    --exec-timeout 2m -- /bin/sh -c 'sleep 4; echo DAEMON_ROUTE_RW_OK' \
    >"$evidence_dir/route-rw.log" 2>&1 &
route_rw_pid=$!
"$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" --workspace-read-only --session-id route-ro \
    --exec-timeout 2m -- /bin/sh -c 'sleep 4; echo DAEMON_ROUTE_RO_OK' \
    >"$evidence_dir/route-ro.log" 2>&1 &
route_ro_pid=$!
attempt=0
while :; do
    "$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-two-routes.json"
    if grep -q '"workers":2' "$evidence_dir/status-two-routes.json" &&
        grep -q '"leases":2' "$evidence_dir/status-two-routes.json"; then
        break
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 300 ]; then echo "two active routes were not observed" >&2; exit 1; fi
    sleep 0.1
done
if "$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" --network restricted \
    --allow-domain example.com --allow-port 443 -- /bin/true \
    >"$evidence_dir/quota.stdout" 2>"$evidence_dir/quota.stderr"; then
    echo "third active route unexpectedly bypassed quota" >&2
    exit 1
fi
grep -q 'VM pool quota is exhausted' "$evidence_dir/quota.stderr"
wait "$route_rw_pid"
wait "$route_ro_pid"
grep -q DAEMON_ROUTE_RW_OK "$evidence_dir/route-rw.log"
grep -q DAEMON_ROUTE_RO_OK "$evidence_dir/route-ro.log"

"$zapvm" daemon exec --endpoint "$endpoint" --workspace "$workspace" --network restricted \
    --allow-domain example.com --allow-port 443 --session-id route-restricted \
    --exec-timeout 2m -- /bin/sh -c 'echo DAEMON_LRU_RESTRICTED_OK' \
    >"$evidence_dir/route-restricted.log"
grep -q DAEMON_LRU_RESTRICTED_OK "$evidence_dir/route-restricted.log"
"$zapvm" daemon status --endpoint "$endpoint" >"$evidence_dir/status-after-lru.json"
grep -q '"workers":2' "$evidence_dir/status-after-lru.json"

"$zapvm" daemon pause --endpoint "$endpoint"
"$zapvm" daemon stop --endpoint "$endpoint"
wait "$daemon_pid"
daemon_pid=
test ! -e "$endpoint"

state_count=0
for state_disk in "$evidence_dir"/state/*.raw; do
    test -f "$state_disk"
    state_count=$((state_count + 1))
    state_json="$evidence_dir/state-$(basename "$state_disk" .raw).json"
    "$zapvm" state inspect --disk "$state_disk" >"$state_json"
    grep -q '"clean_shutdown": true' "$state_json"
done
test "$state_count" -ge 3
if capture_residual_processes >"$evidence_dir/process-residual.log"; then
    echo "daemon acceptance left a zapvm process" >&2
    exit 1
fi
rm -f "$credential"
test ! -e "$credential"
printf '%s\n' "boot_id=$boot_before" "pause_drain_seconds=$pause_elapsed" "state_count=$state_count" \
    >"$evidence_dir/assertions.txt"
printf 'UNIX_DAEMON_ACCEPTANCE_OK host=%s evidence=%s\n' "$host_os" "$evidence_dir"
