#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Darwin ]; then
    echo "this soak entry must run on macOS" >&2
    exit 2
fi

duration_seconds=${1:-259200}
interval_seconds=${2:-30}
evidence_dir=${3:-"$repo_dir/.cache/acceptance/mac-soak-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
pressure_mib=${ZAPVM_SOAK_PRESSURE_MIB:-16}
sample_seconds=${ZAPVM_SOAK_SAMPLE_SECONDS:-1}

for value_name in duration_seconds interval_seconds pressure_mib sample_seconds; do
    eval value=\$$value_name
    case "$value" in
        *[!0-9]*|'') echo "$value_name must be a positive integer" >&2; exit 2 ;;
    esac
    if [ "$value" -le 0 ]; then
        echo "$value_name must be a positive integer" >&2
        exit 2
    fi
done
if [ -e "$evidence_dir" ]; then
    echo "refusing existing evidence directory: $evidence_dir" >&2
    exit 2
fi

mkdir -p "$evidence_dir/workspace" "$evidence_dir/iterations"
zapvm="$repo_dir/bin/zapvm"
image_tool="$evidence_dir/zapvm-image"
image_root="$evidence_dir/images"
image_private_key="$evidence_dir/image-private.pem"
image_public_key="$evidence_dir/image-public.pem"
image_signature="$evidence_dir/manifest.sig"
state_disk="$evidence_dir/state.raw"
workspace="$evidence_dir/workspace"
metrics="$evidence_dir/metrics.csv"
iteration_summary="$evidence_dir/iteration-summary.csv"

test -x "$zapvm" || { echo "missing signed Host CLI: $zapvm" >&2; exit 1; }
for artifact in kernel initramfs rootfs.raw state.raw; do
    test -f "$repo_dir/dist/arm64/$artifact" || {
        echo "missing dist/arm64/$artifact" >&2
        exit 1
    }
done

(cd "$repo_dir" && go build -trimpath -o "$image_tool" ./cmd/zapvm-image)
"$image_tool" keygen --private "$image_private_key" --public "$image_public_key"
"$image_tool" sign --manifest "$repo_dir/dist/arm64/manifest.json" --private-key "$image_private_key" --output "$image_signature"
rm -f "$image_private_key"
"$image_tool" install \
	--manifest "$repo_dir/dist/arm64/manifest.json" \
	--signature "$image_signature" \
	--public-key "$image_public_key" \
	--destination "$image_root/0.1.0-dev"
"$image_tool" activate --root "$image_root" --version 0.1.0-dev --public-key "$image_public_key"

{
    date -u '+started_at=%Y-%m-%dT%H:%M:%SZ'
    sw_vers
    uname -a
    "$zapvm" version
    printf 'duration_seconds=%s\ninterval_seconds=%s\npressure_mib=%s\nsample_seconds=%s\n' \
        "$duration_seconds" "$interval_seconds" "$pressure_mib" "$sample_seconds"
} >"$evidence_dir/environment.txt"
"$zapvm" doctor >"$evidence_dir/doctor.log" 2>&1
"$zapvm" state create \
	--template "$repo_dir/dist/arm64/state.raw" \
	--output "$state_disk" \
	--format raw \
	--schema 2 >"$evidence_dir/state-create.log"

printf 'timestamp,iteration,phase,pid,rss_kib,vsz_kib,open_files,host_mounts,state_physical_kib\n' >"$metrics"
printf 'iteration,duration_seconds,peak_rss_kib,peak_open_files,host_mount_min,host_mount_max,state_physical_kib\n' >"$iteration_summary"
start_epoch=$(date +%s)
end_epoch=$((start_epoch + duration_seconds))
iteration=0

record_metrics() {
    phase=$1
    pid=$2
    rss=0
    vsz=0
    open_files=0
    if kill -0 "$pid" 2>/dev/null; then
        rss=$(ps -o rss= -p "$pid" | tr -d ' ')
        vsz=$(ps -o vsz= -p "$pid" | tr -d ' ')
        rss=${rss:-0}
        vsz=${vsz:-0}
        if command -v lsof >/dev/null 2>&1; then
            open_files=$(lsof -n -P -p "$pid" 2>/dev/null | wc -l | tr -d ' ')
        fi
    fi
    host_mounts=$(mount | wc -l | tr -d ' ')
    state_kib=$(du -k "$state_disk" | awk '{print $1}')
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$iteration" "$phase" "$pid" \
        "$rss" "$vsz" "$open_files" "$host_mounts" "$state_kib" >>"$metrics"
}

while :; do
    now=$(date +%s)
    if [ "$iteration" -gt 0 ] && [ "$now" -ge "$end_epoch" ]; then
        break
    fi
    iteration=$((iteration + 1))
    iteration_start=$(date +%s)
    log="$evidence_dir/iterations/$(printf '%06d' "$iteration").log"

    "$zapvm" run \
        --id "mac-long-soak-$iteration" \
		--image-root "$image_root" \
		--image-public-key "$image_public_key" \
        --state-disk "$state_disk" \
        --workspace "$workspace" \
        --session-id long-soak \
        --cmdline 'console=hvc0 root=/dev/vda ro rootfstype=ext4 modules=ext4,virtio_blk,virtiofs,virtio_balloon' \
        --network off \
        --console=false \
        --exec-timeout 5m \
        --stop-after-exec \
        -- /bin/sh -c '
            set -eu
            expected=$1
            pressure_mib=$2
            counter=/var/lib/zapvm/data/long-soak-count
            previous=0
            if [ -f "$counter" ]; then previous=$(cat "$counter"); fi
            test "$previous" -eq "$((expected - 1))"
            printf "%s\n" "$expected" >"$counter"
            printf "%s\n" "$expected" >"$HOME/long-soak-home-count"
            printf "%s\n" "$expected" >long-soak-workspace-count
            dd if=/dev/zero of=/tmp/zapvm-pressure bs=1M count="$pressure_mib" status=none
            dd if=/dev/zero of=/var/lib/zapvm/data/pressure.tmp bs=1M count="$pressure_mib" status=none
            for worker in 1 2 3 4; do
                (index=0; while [ "$index" -lt 2000 ]; do index=$((index + 1)); :; done) &
            done
            wait
            rm /var/lib/zapvm/data/pressure.tmp /tmp/zapvm-pressure
            sync
            echo "LONG_SOAK_ITERATION_${expected}_OK"
        ' soak "$iteration" "$pressure_mib" >"$log" 2>&1 &
    vm_pid=$!
    record_metrics running "$vm_pid"
    while kill -0 "$vm_pid" 2>/dev/null; do
        sleep "$sample_seconds"
        record_metrics running "$vm_pid"
    done
    if wait "$vm_pid"; then
        record_metrics stopped "$vm_pid"
    else
        status=$?
        record_metrics failed "$vm_pid"
        tail -n 200 "$log" >&2
        echo "soak iteration $iteration failed with status $status; evidence: $evidence_dir" >&2
        exit "$status"
    fi
    grep -q "LONG_SOAK_ITERATION_${iteration}_OK" "$log"
    test "$(cat "$workspace/long-soak-workspace-count")" -eq "$iteration"
    state_snapshot="$evidence_dir/iterations/$(printf '%06d' "$iteration").state.json"
    "$zapvm" state inspect --disk "$state_disk" >"$state_snapshot"
    grep -q '"clean_shutdown": true' "$state_snapshot"

    peak_rss=$(awk -F, -v wanted="$iteration" 'NR > 1 && $2 == wanted && ($5 + 0) > peak { peak = $5 + 0 } END { print peak + 0 }' "$metrics")
    peak_fds=$(awk -F, -v wanted="$iteration" 'NR > 1 && $2 == wanted && ($7 + 0) > peak { peak = $7 + 0 } END { print peak + 0 }' "$metrics")
    mount_min=$(awk -F, -v wanted="$iteration" 'NR > 1 && $2 == wanted { value = $8 + 0; if (!seen || value < result) result = value; seen = 1 } END { print result + 0 }' "$metrics")
    mount_max=$(awk -F, -v wanted="$iteration" 'NR > 1 && $2 == wanted && ($8 + 0) > result { result = $8 + 0 } END { print result + 0 }' "$metrics")
    state_kib=$(du -k "$state_disk" | awk '{print $1}')
    printf '%s,%s,%s,%s,%s,%s,%s\n' "$iteration" "$(( $(date +%s) - iteration_start ))" \
        "$peak_rss" "$peak_fds" "$mount_min" "$mount_max" "$state_kib" >>"$iteration_summary"

    now=$(date +%s)
    if [ "$now" -ge "$end_epoch" ]; then
        break
    fi
    remaining=$((end_epoch - now))
    pause=$interval_seconds
    if [ "$pause" -gt "$remaining" ]; then pause=$remaining; fi
    sleep "$pause"
done

"$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-final.json"
grep -q '"clean_shutdown": true' "$evidence_dir/state-final.json"
test "$(cat "$workspace/long-soak-workspace-count")" -eq "$iteration"
if ps -axo command= | grep '[b]in/zapvm run' | grep -F "$evidence_dir" >/dev/null 2>&1; then
    echo "a soak VM process remains after completion" >&2
    exit 1
fi

end_actual=$(date +%s)
peak_rss=$(awk -F, 'NR > 1 && ($5 + 0) > peak { peak = $5 + 0 } END { print peak + 0 }' "$metrics")
peak_fds=$(awk -F, 'NR > 1 && ($7 + 0) > peak { peak = $7 + 0 } END { print peak + 0 }' "$metrics")
mount_min=$(awk -F, 'NR > 1 { value = $8 + 0; if (!seen || value < result) result = value; seen = 1 } END { print result + 0 }' "$metrics")
mount_max=$(awk -F, 'NR > 1 && ($8 + 0) > result { result = $8 + 0 } END { print result + 0 }' "$metrics")
state_kib=$(du -k "$state_disk" | awk '{print $1}')
{
    printf '{\n'
    printf '  "result": "pass",\n'
    printf '  "iterations": %s,\n' "$iteration"
    printf '  "requested_duration_seconds": %s,\n' "$duration_seconds"
    printf '  "actual_duration_seconds": %s,\n' "$((end_actual - start_epoch))"
    printf '  "peak_rss_kib": %s,\n' "$peak_rss"
    printf '  "peak_open_files": %s,\n' "$peak_fds"
    printf '  "host_mount_min": %s,\n' "$mount_min"
    printf '  "host_mount_max": %s,\n' "$mount_max"
    printf '  "state_physical_kib": %s,\n' "$state_kib"
    printf '  "evidence_directory": "%s"\n' "$evidence_dir"
    printf '}\n'
} >"$evidence_dir/summary.json"
cat "$evidence_dir/summary.json"
