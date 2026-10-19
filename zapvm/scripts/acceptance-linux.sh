#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
phase=${ZAPVM_ACCEPTANCE_PHASE:-complete}
snapshot_in=${ZAPVM_ACCEPTANCE_SNAPSHOT_IN:-}
snapshot_out=${ZAPVM_ACCEPTANCE_SNAPSHOT_OUT:-}
case "$phase" in
    complete|write|persistence-isolation|readonly|restricted|crash|recovery|daemon-single) ;;
    *) echo "unsupported Linux acceptance phase: $phase" >&2; exit 2 ;;
esac
if [ "$phase" = complete ] && { [ -n "$snapshot_in" ] || [ -n "$snapshot_out" ]; }; then
    echo "snapshot inputs are only valid for phased Linux acceptance" >&2
    exit 2
fi
if [ "$(uname -s)" != Linux ]; then
    echo "this acceptance entry must run on a real Linux host" >&2
    exit 2
fi
if [ "$(id -u)" -eq 0 ]; then
    echo "Linux acceptance must run as the non-root desktop/login user" >&2
    exit 2
fi
if ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "systemd user manager is unavailable; use a real login session or enable linger for this test user" >&2
    exit 2
fi
case "${ZAPVM_ARCH:-$(uname -m)}" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "unsupported host architecture" >&2; exit 2 ;;
esac

evidence_dir=${1:-"$repo_dir/.cache/acceptance/linux-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
if [ -e "$evidence_dir" ]; then
    echo "refusing existing evidence directory: $evidence_dir" >&2
    exit 2
fi
mkdir -p "$evidence_dir"
if [ -n "$snapshot_in" ]; then
    case "$snapshot_in" in
        /*) ;;
        *) echo "ZAPVM_ACCEPTANCE_SNAPSHOT_IN must be absolute" >&2; exit 2 ;;
    esac
    test -f "$snapshot_in" || { echo "missing Linux acceptance snapshot: $snapshot_in" >&2; exit 1; }
    if tar -tzf "$snapshot_in" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
        echo "Linux acceptance snapshot contains an unsafe path" >&2
        exit 1
    fi
    tar -xzf "$snapshot_in" -C "$evidence_dir"
    test -f "$evidence_dir/state.raw" || { echo "snapshot is missing state.raw" >&2; exit 1; }
    test -f "$evidence_dir/state.raw.zapvm-state.json" || { echo "snapshot is missing state metadata" >&2; exit 1; }
    test -d "$evidence_dir/workspace" || { echo "snapshot is missing workspace" >&2; exit 1; }
else
    mkdir -p "$evidence_dir/workspace"
fi
dist_dir="$repo_dir/dist/$arch"
zapvm="$evidence_dir/zapvm"
image_tool="$evidence_dir/zapvm-image"
image_root="$evidence_dir/images"
image_private_key="$evidence_dir/image-private.pem"
image_public_key="$evidence_dir/image-public.pem"
image_signature="$evidence_dir/manifest.sig"
state_disk="$evidence_dir/state.raw"
workspace="$evidence_dir/workspace"
host_uid=$(id -u)
host_gid=$(id -g)
host_identity="$evidence_dir/host-identity.txt"
if [ -n "$snapshot_in" ]; then
    test "$(cat "$host_identity")" = "$host_uid:$host_gid" || {
        echo "snapshot Host identity does not match this runner ($host_uid:$host_gid)" >&2
        exit 1
    }
else
    printf '%s:%s\n' "$host_uid" "$host_gid" >"$host_identity"
fi
signed_image_bundle=${ZAPVM_ACCEPTANCE_IMAGE_BUNDLE:-}
signed_image_public_key=${ZAPVM_ACCEPTANCE_IMAGE_PUBLIC_KEY:-}
prebuilt_zapvm=${ZAPVM_ACCEPTANCE_ZAPVM:-}
prebuilt_image_tool=${ZAPVM_ACCEPTANCE_IMAGE_TOOL:-}

write_snapshot() {
    [ -n "$snapshot_out" ] || { echo "ZAPVM_ACCEPTANCE_SNAPSHOT_OUT is required for phase $phase" >&2; exit 2; }
    case "$snapshot_out" in
        /*) ;;
        *) echo "ZAPVM_ACCEPTANCE_SNAPSHOT_OUT must be absolute" >&2; exit 2 ;;
    esac
    if [ -e "$snapshot_out" ]; then
        echo "refusing existing Linux acceptance snapshot output: $snapshot_out" >&2
        exit 2
    fi
    tar --sparse -czf "$snapshot_out" -C "$evidence_dir" \
        state.raw state.raw.zapvm-state.json host-identity.txt workspace
    printf 'LINUX_ACCEPTANCE_PHASE_OK phase=%s snapshot=%s evidence=%s\n' "$phase" "$snapshot_out" "$evidence_dir"
}

if { [ -n "$signed_image_bundle" ] && [ -z "$signed_image_public_key" ]; } ||
    { [ -z "$signed_image_bundle" ] && [ -n "$signed_image_public_key" ]; }; then
    echo "ZAPVM_ACCEPTANCE_IMAGE_BUNDLE and ZAPVM_ACCEPTANCE_IMAGE_PUBLIC_KEY must be provided together" >&2
    exit 2
fi
if { [ -n "$prebuilt_zapvm" ] && [ -z "$prebuilt_image_tool" ]; } ||
    { [ -z "$prebuilt_zapvm" ] && [ -n "$prebuilt_image_tool" ]; }; then
    echo "ZAPVM_ACCEPTANCE_ZAPVM and ZAPVM_ACCEPTANCE_IMAGE_TOOL must be provided together" >&2
    exit 2
fi

if [ -n "$prebuilt_zapvm" ]; then
    case "$prebuilt_zapvm:$prebuilt_image_tool" in
        /*:/*) ;;
        *) echo "prebuilt zapvm and image-tool paths must be absolute" >&2; exit 2 ;;
    esac
    test -f "$prebuilt_zapvm" && test -x "$prebuilt_zapvm" || { echo "missing executable zapvm: $prebuilt_zapvm" >&2; exit 1; }
    test -f "$prebuilt_image_tool" && test -x "$prebuilt_image_tool" || { echo "missing executable image tool: $prebuilt_image_tool" >&2; exit 1; }
    install -m 0755 "$prebuilt_zapvm" "$zapvm"
    install -m 0755 "$prebuilt_image_tool" "$image_tool"
else
    (cd "$repo_dir" && CGO_ENABLED=0 go build -trimpath -o "$zapvm" ./cmd/zapvm)
    (cd "$repo_dir" && CGO_ENABLED=0 go build -trimpath -o "$image_tool" ./cmd/zapvm-image)
fi
if [ -n "$signed_image_bundle" ]; then
    case "$signed_image_bundle:$signed_image_public_key" in
        /*:/*) ;;
        *) echo "pre-signed bundle and public key paths must be absolute" >&2; exit 2 ;;
    esac
    test -f "$signed_image_bundle" || { echo "missing signed image bundle: $signed_image_bundle" >&2; exit 1; }
    test -f "$signed_image_public_key" || { echo "missing signed image public key: $signed_image_public_key" >&2; exit 1; }
    image_public_key=$signed_image_public_key
    "$image_tool" install-bundle \
        --bundle "$signed_image_bundle" \
        --public-key "$image_public_key" \
        --root "$image_root" \
        --arch "$arch" \
        --smoke-binary "$zapvm"
    active_version=$("$image_tool" status --root "$image_root" | sed -n 's/^[[:space:]]*"active_version": "\([^"]*\)",*$/\1/p')
    test -n "$active_version" || { echo "unable to resolve imported active image version" >&2; exit 1; }
    state_template="$image_root/$active_version/state.raw"
else
    for artifact in kernel initramfs rootfs.raw state.raw cloud-hypervisor virtiofsd linux-runtime-provenance.json manifest.json; do
        test -f "$dist_dir/$artifact" || {
            echo "missing $dist_dir/$artifact" >&2
            exit 1
        }
    done
    if ! grep -Eq '"profile"[[:space:]]*:[[:space:]]*"host-runtime"' "$dist_dir/manifest.json"; then
        test -f "$dist_dir/agent.raw" || { echo "missing $dist_dir/agent.raw" >&2; exit 1; }
    fi
    "$image_tool" keygen --private "$image_private_key" --public "$image_public_key"
    "$image_tool" sign --manifest "$dist_dir/manifest.json" --private-key "$image_private_key" --output "$image_signature"
    rm -f "$image_private_key"
    "$image_tool" install --manifest "$dist_dir/manifest.json" --signature "$image_signature" --public-key "$image_public_key" --destination "$image_root/0.1.0-dev"
    "$image_tool" activate --root "$image_root" --version 0.1.0-dev --public-key "$image_public_key"
    state_template="$dist_dir/state.raw"
fi
"$zapvm" doctor >"$evidence_dir/doctor.log" 2>&1
cat "$evidence_dir/doctor.log"
if [ ! -f "$state_disk" ]; then
    "$zapvm" state create --template "$state_template" --output "$state_disk" --format raw --schema 3
fi

run_vm() {
    # Keep the virtio console attached so a pre-Agent boot failure is part of
    # the acceptance evidence instead of collapsing into a VSOCK reset.
    "$zapvm" run \
		--image-root "$image_root" \
		--image-public-key "$image_public_key" \
        --state-disk "$state_disk" \
        --workspace "$workspace" \
        --cmdline 'console=hvc0 root=/dev/vda ro rootfstype=ext4 modules=ext4,virtio_blk,virtiofs' \
        --console=true \
        --stop-after-exec \
        "$@"
}

run_vm_with_kvm_retry() {
    attempt=1
    while [ "$attempt" -le 3 ]; do
        retry_dir=$(mktemp -d "${TMPDIR:-/tmp}/zapvm-kvm-retry.XXXXXX")
        if run_vm "$@" >"$retry_dir/stdout" 2>"$retry_dir/stderr"; then
            status=0
        else
            status=$?
        fi
        cat "$retry_dir/stdout"
        cat "$retry_dir/stderr" >&2
        if [ "$status" -eq 0 ]; then
            rm -rf "$retry_dir"
            return 0
        fi
        if [ "$attempt" -ge 3 ] ||
            ! grep -F "CreateHypervisor(VmCreate(Permission denied" "$retry_dir/stdout" "$retry_dir/stderr" >/dev/null 2>&1; then
            rm -rf "$retry_dir"
            return "$status"
        fi
        case "$attempt" in
            1) delay=10 ;;
            *) delay=30 ;;
        esac
        printf 'host KVM_CREATE_VM was transiently denied; retrying in %ss (attempt %s/3)\n' "$delay" "$attempt" >&2
        rm -rf "$retry_dir"
        sleep "$delay"
        attempt=$((attempt + 1))
    done
}

if [ "$phase" = complete ] || [ "$phase" = write ]; then
run_vm_with_kvm_retry --id linux-accept-write --session-id acceptance-a --network off \
    --restart-agent-before-exec -- /bin/sh -c '
        set -eu
        printf "guest_uid=%s guest_gid=%s cwd=%s workspace_owner=%s state_owner=%s\n" \
            "$(id -u)" "$(id -g)" "$PWD" "$(stat -c %u:%g:%a .)" "$(stat -c %u:%g:%a /var/lib/zapvm/data)"
        test "$(id -u)" -eq "$1"
        test "$(id -g)" -eq "$2"
        test "$PWD" = /workspace
        printf "workspace-ok\n" >platform-acceptance
        printf "home-a-ok\n" >"$HOME/platform-acceptance"
        printf "state-ok\n" >/var/lib/zapvm/data/platform-acceptance
        sync
        echo LINUX_WRITE_RESTART_OK
    ' zapvm-acceptance "$host_uid" "$host_gid" >"$evidence_dir/write.log" 2>&1
cat "$evidence_dir/write.log"

test "$(cat "$workspace/platform-acceptance")" = workspace-ok
if [ "$phase" = write ]; then
    "$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-write.json"
    grep -q '"clean_shutdown": true' "$evidence_dir/state-write.json"
    write_snapshot
    exit 0
fi
fi

if [ "$phase" = persistence-isolation ]; then
    plan="$evidence_dir/persistence-isolation-plan.json"
    cat >"$plan" <<'JSON'
{"schema_version":1,"parallel":false,"commands":[{"id":"persistence","session_id":"acceptance-a","argv":["/bin/sh","-c","set -eu; test \"$(cat platform-acceptance)\" = workspace-ok; test \"$(cat \"$HOME/platform-acceptance\")\" = home-a-ok; test \"$(cat /var/lib/zapvm/data/platform-acceptance)\" = state-ok; echo LINUX_PERSISTENCE_OK"]},{"id":"isolation","session_id":"acceptance-b","argv":["/bin/sh","-c","set -eu; test ! -e \"$HOME/platform-acceptance\"; test \"$(cat /var/lib/zapvm/data/platform-acceptance)\" = state-ok; echo LINUX_SESSION_ISOLATION_OK"]}]}
JSON
    run_vm_with_kvm_retry --id linux-accept-persist-isolate --network off --exec-plan "$plan" \
        >"$evidence_dir/persistence-isolation.jsonl" 2>"$evidence_dir/persistence-isolation.log"
    test "$(grep -c '"type":"result","ok":true' "$evidence_dir/persistence-isolation.jsonl")" -eq 2
    if grep -q '"type":"result","ok":false' "$evidence_dir/persistence-isolation.jsonl"; then
        echo "persistence/isolation execution plan reported failure" >&2
        exit 1
    fi
    "$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-persistence-isolation.json"
    grep -q '"clean_shutdown": true' "$evidence_dir/state-persistence-isolation.json"
    write_snapshot
    exit 0
fi

if [ "$phase" = complete ]; then
run_vm_with_kvm_retry --id linux-accept-persist --session-id acceptance-a --network off -- /bin/sh -c '
    set -eu
    test "$(cat platform-acceptance)" = workspace-ok
    test "$(cat "$HOME/platform-acceptance")" = home-a-ok
    test "$(cat /var/lib/zapvm/data/platform-acceptance)" = state-ok
    echo LINUX_PERSISTENCE_OK
' >"$evidence_dir/persistence.log" 2>&1
cat "$evidence_dir/persistence.log"

run_vm_with_kvm_retry --id linux-accept-isolation --session-id acceptance-b --network off -- /bin/sh -c '
    set -eu
    test ! -e "$HOME/platform-acceptance"
    test "$(cat /var/lib/zapvm/data/platform-acceptance)" = state-ok
    echo LINUX_SESSION_ISOLATION_OK
' >"$evidence_dir/isolation.log" 2>&1
cat "$evidence_dir/isolation.log"
fi

if [ "$phase" = complete ] || [ "$phase" = readonly ]; then
run_vm_with_kvm_retry --id linux-accept-readonly --session-id acceptance-a --network off \
    --workspace-read-only -- /bin/sh -c '
        set -eu
        if printf "unexpected-write\n" >.zapvm-readonly-probe; then
            echo "read-only workspace accepted a write" >&2
            exit 1
        fi
        test ! -e .zapvm-readonly-probe
        test "$(cat platform-acceptance)" = workspace-ok
        echo LINUX_READONLY_OK
    ' >"$evidence_dir/readonly.log" 2>&1
cat "$evidence_dir/readonly.log"
if [ "$phase" = readonly ]; then
    "$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-readonly.json"
    grep -q '"clean_shutdown": true' "$evidence_dir/state-readonly.json"
    write_snapshot
    exit 0
fi
fi

if [ "$phase" = complete ] || [ "$phase" = restricted ]; then
run_vm_with_kvm_retry --id linux-accept-restricted --session-id acceptance-a \
    --network restricted --allow-domain example.com --allow-port 443 --egress-audit-json -- \
    /bin/sh -c '
        set -eu
        curl -fsS --max-time 20 https://example.com >/dev/null
        if curl -fsS --max-time 5 https://www.iana.org >/dev/null 2>&1; then
            exit 1
        fi
        echo LINUX_RESTRICTED_POLICY_OK
    ' >"$evidence_dir/restricted.log" 2>"$evidence_dir/restricted-audit.log"
cat "$evidence_dir/restricted.log"
cat "$evidence_dir/restricted-audit.log" >&2
if [ "$phase" = restricted ]; then
    "$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-restricted.json"
    grep -q '"clean_shutdown": true' "$evidence_dir/state-restricted.json"
    write_snapshot
    exit 0
fi
fi

if [ "$phase" = complete ] || [ "$phase" = crash ]; then
if run_vm_with_kvm_retry --id linux-accept-crash --session-id acceptance-a --network off \
    --heartbeat-interval 500ms --heartbeat-timeout 250ms --crash-agent-after 1s -- \
    /bin/sh -c '
        printf "crash-written\n" >/var/lib/zapvm/data/crash-marker
        sync
        sleep 30
        echo UNEXPECTED_CRASH_COMPLETION
    ' >"$evidence_dir/crash.log" 2>&1; then
    echo "agent crash injection unexpectedly succeeded" >&2
    exit 1
fi
if grep -q UNEXPECTED_CRASH_COMPLETION "$evidence_dir/crash.log"; then
    echo "workload continued after agent crash" >&2
    exit 1
fi
if [ "$phase" = crash ]; then
    "$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-crash.json"
    grep -q '"clean_shutdown": false' "$evidence_dir/state-crash.json"
    write_snapshot
    exit 0
fi
fi

if [ "$phase" = complete ] || [ "$phase" = recovery ]; then
run_vm_with_kvm_retry --id linux-accept-recover --session-id acceptance-a --network off -- /bin/sh -c '
    set -eu
    test "$(cat /var/lib/zapvm/data/crash-marker)" = crash-written
    echo LINUX_CRASH_RECOVERY_OK
' >"$evidence_dir/recovery.log" 2>&1
cat "$evidence_dir/recovery.log"
if [ "$phase" = recovery ]; then
    "$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-recovery.json"
    grep -q '"clean_shutdown": true' "$evidence_dir/state-recovery.json"
    write_snapshot
    exit 0
fi
fi

"$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-final.json"
cat "$evidence_dir/state-final.json"
grep -q '"clean_shutdown": true' "$evidence_dir/state-final.json"
if [ "$phase" = daemon-single ]; then
    ZAPVM_DAEMON_SINGLE_VM=1 sh "$script_dir/acceptance-daemon-linux.sh" \
        "$zapvm" "$image_root" "$image_public_key" "$workspace" "$evidence_dir/daemon"
    "$zapvm" state inspect --disk "$state_disk" >"$evidence_dir/state-daemon-host.json"
    grep -q '"clean_shutdown": true' "$evidence_dir/state-daemon-host.json"
    write_snapshot
    exit 0
fi

sh "$script_dir/acceptance-daemon-linux.sh" \
    "$zapvm" "$image_root" "$image_public_key" "$workspace" "$evidence_dir/daemon"
printf 'LINUX_ACCEPTANCE_OK evidence=%s\n' "$evidence_dir"
