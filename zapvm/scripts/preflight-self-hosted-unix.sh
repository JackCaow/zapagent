#!/usr/bin/env bash
set -u

usage() {
    echo "usage: $0 linux-multi|linux-power|macos-power|macos-soak-72h [WAKE_SECONDS]" >&2
    exit 2
}

target=${1:-}
case "$target" in
    linux-multi|linux-power|macos-power|macos-soak-72h) ;;
    *) usage ;;
esac
wake_seconds=${2:-45}
case "$wake_seconds" in
    ''|*[!0-9]*) usage ;;
esac
if [ "$wake_seconds" -lt 30 ] || [ "$wake_seconds" -gt 300 ]; then
    usage
fi

failed=0
pass() { printf 'pass  %-32s %s\n' "$1" "$2"; }
fail() { printf 'fail  %-32s %s\n' "$1" "$2" >&2; failed=1; }

require_command() {
    name=$1
    if path=$(command -v "$name" 2>/dev/null); then
        pass "command-$name" "$path"
    else
        fail "command-$name" "not found"
    fi
}

check_sudo_permission() {
    name=$1
    shift
    if sudo -n -l "$@" >/dev/null 2>&1; then
        pass "$name" "passwordless command is authorized"
    else
        fail "$name" "configure a narrow NOPASSWD sudoers rule for: $*"
    fi
}

platform=$(uname -s)
architecture=$(uname -m)
uid=$(id -u)
printf 'target=%s\nplatform=%s\narchitecture=%s\nuid=%s\n' "$target" "$platform" "$architecture" "$uid"

case "$target" in
    linux-*)
        if [ "$platform" = Linux ]; then pass host-os Linux; else fail host-os "want Linux, got $platform"; fi
        if [ "$architecture" = x86_64 ]; then pass host-architecture x86_64; else fail host-architecture "want x86_64, got $architecture"; fi
        if [ "$uid" -ne 0 ]; then pass non-root-user "uid=$uid"; else fail non-root-user "the runner must not run as root"; fi

        require_command systemd
        require_command systemctl
        require_command systemd-run
        require_command python3
        if command -v systemd >/dev/null 2>&1; then
            systemd_version=$(systemd --version | awk 'NR == 1 { print $2 }')
            case "$systemd_version" in
                ''|*[!0-9]*) fail systemd-version "unable to parse: $systemd_version" ;;
                *)
                    if [ "$systemd_version" -ge 254 ]; then pass systemd-version "$systemd_version"; else fail systemd-version "want 254+, got $systemd_version"; fi
                    ;;
            esac
        fi

        cgroup_type=$(stat -fc %T /sys/fs/cgroup 2>/dev/null || true)
        if [ "$cgroup_type" = cgroup2fs ]; then pass cgroup-v2 "$cgroup_type"; else fail cgroup-v2 "want cgroup2fs, got ${cgroup_type:-unavailable}"; fi

        if [ -c /dev/kvm ]; then
            pass kvm-device "$(ls -l /dev/kvm)"
            if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
                pass kvm-permission "current user has read/write access"
            else
                fail kvm-permission "preconfigure udev/group ACL; the acceptance workflow will not modify /dev/kvm"
            fi
        else
            fail kvm-device "/dev/kvm is not a character device"
        fi
        if [ -r /dev/kvm ] && [ -w /dev/kvm ] && command -v python3 >/dev/null 2>&1; then
            if python3 - <<'PY'
import fcntl
import os

fd = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
try:
    version = fcntl.ioctl(fd, 0xAE00, 0)
finally:
    os.close(fd)
if version != 12:
    raise SystemExit(f"unexpected KVM API version: {version}")
print(f"KVM_GET_API_VERSION={version}")
PY
            then pass kvm-ioctl "KVM API version 12"; else fail kvm-ioctl "KVM_GET_API_VERSION failed"; fi
        fi

        if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] &&
           [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1 ]; then
            fail apparmor-userns "preconfigure kernel.apparmor_restrict_unprivileged_userns=0"
        else
            pass apparmor-userns "unprivileged user namespaces are not AppArmor-restricted"
        fi
        if [ -r /proc/sys/kernel/unprivileged_userns_clone ] &&
           [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = 0 ]; then
            fail unprivileged-userns "preconfigure kernel.unprivileged_userns_clone=1"
        else
            pass unprivileged-userns "enabled"
        fi
        max_user_namespaces=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || printf 0)
        case "$max_user_namespaces" in
            ''|*[!0-9]*) fail max-user-namespaces "unable to parse: $max_user_namespaces" ;;
            0) fail max-user-namespaces "must be greater than zero" ;;
            *) pass max-user-namespaces "$max_user_namespaces" ;;
        esac

        xdg_runtime_dir=/run/user/$uid
        export XDG_RUNTIME_DIR=$xdg_runtime_dir
        if [ -d "$xdg_runtime_dir" ] && [ -O "$xdg_runtime_dir" ]; then
            pass xdg-runtime-dir "$xdg_runtime_dir"
        else
            fail xdg-runtime-dir "$xdg_runtime_dir must already exist and be owned by the runner user"
        fi
        if systemctl --user show-environment >/dev/null 2>&1; then
            pass systemd-user-manager "reachable"
        else
            fail systemd-user-manager "enable linger/start user@${uid}.service before registering the runner"
        fi
        if systemd-run --user --scope --quiet true >/dev/null 2>&1; then
            pass systemd-user-scope "transient scope completed"
        else
            fail systemd-user-scope "unable to run a transient user scope"
        fi

        if [ "$target" = linux-power ]; then
            require_command rtcwake
            require_command sudo
            rtcwake_path=$(command -v rtcwake 2>/dev/null || true)
            systemctl_path=$(command -v systemctl 2>/dev/null || true)
            if [ -n "$rtcwake_path" ] && command -v sudo >/dev/null 2>&1; then
                check_sudo_permission sudo-rtcwake "$rtcwake_path" -m no -s "$wake_seconds"
            fi
            if [ -n "$systemctl_path" ] && command -v sudo >/dev/null 2>&1; then
                check_sudo_permission sudo-systemctl-suspend "$systemctl_path" suspend
            fi
        fi
        ;;
    macos-*)
        if [ "$platform" = Darwin ]; then pass host-os Darwin; else fail host-os "want Darwin, got $platform"; fi
        if [ "$architecture" = arm64 ]; then pass host-architecture arm64; else fail host-architecture "want arm64, got $architecture"; fi
        if [ "$uid" -ne 0 ]; then pass non-root-user "uid=$uid"; else fail non-root-user "the runner must not run as root"; fi
        for command_name in go docker make codesign; do require_command "$command_name"; done
        if [ -d /System/Library/Frameworks/Virtualization.framework ]; then
            pass virtualization-framework "present"
        else
            fail virtualization-framework "missing"
        fi
        hv_support=$(sysctl -n kern.hv_support 2>/dev/null || printf 0)
        if [ "$hv_support" = 1 ]; then pass hypervisor-framework "kern.hv_support=1"; else fail hypervisor-framework "kern.hv_support=$hv_support"; fi
        if docker info >/dev/null 2>&1; then pass docker-daemon "reachable"; else fail docker-daemon "docker info failed"; fi
        if [ -f packaging/macos/zapvm.entitlements ]; then pass virtualization-entitlement "packaging/macos/zapvm.entitlements"; else fail virtualization-entitlement "missing repository entitlement file"; fi

        if [ "$target" = macos-power ]; then
            require_command pmset
            require_command sudo
            pmset_path=$(command -v pmset 2>/dev/null || true)
            if [ -n "$pmset_path" ] && command -v sudo >/dev/null 2>&1; then
                check_sudo_permission sudo-pmset-wake "$pmset_path" relative wake "$wake_seconds"
                check_sudo_permission sudo-pmset-sleep "$pmset_path" sleepnow
            fi
        else
            workspace=${RUNNER_WORKSPACE:-$PWD}
            available_kib=$(df -Pk "$workspace" | awk 'NR == 2 { print $4 }')
            minimum_kib=$((10 * 1024 * 1024))
            case "$available_kib" in
                ''|*[!0-9]*) fail soak-free-space "unable to parse available space" ;;
                *)
                    if [ "$available_kib" -ge "$minimum_kib" ]; then pass soak-free-space "${available_kib} KiB available"; else fail soak-free-space "need at least 10 GiB, got ${available_kib} KiB"; fi
                    ;;
            esac
        fi
        ;;
esac

if [ "$failed" -ne 0 ]; then
    echo "SELF_HOSTED_PREFLIGHT_FAILED target=$target" >&2
    exit 1
fi
echo "SELF_HOSTED_PREFLIGHT_OK target=$target"
