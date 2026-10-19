#!/bin/sh
set -eu

umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

daemon_unit=zapvm-daemon.service
node_unit=zapvm-node.service

die() {
    printf '%s\n' "zapvm-host-linux: $*" >&2
    exit 1
}

usage() {
    cat >&2 <<'EOF'
usage:
  zapvm-host-linux.sh install|upgrade \
    --source-dir DIR --release-public-key FILE \
    --daemon-config FILE --node-config FILE \
    [--install-root DIR] [--unit-dir DIR] [--no-start]
  zapvm-host-linux.sh rollback|doctor|uninstall \
    [--install-root DIR] [--unit-dir DIR] [--no-start]

The source directory must contain zapvm, zapvm-node, SHA256SUMS and the raw
Ed25519 signature SHA256SUMS.sig. uninstall disables services and removes only
the active/previous pointers and managed user units. Releases, config, logs,
VM state, Computer state, and credentials are retained for recovery.
EOF
    exit 2
}

[ "$(uname -s)" = Linux ] || die "Linux is required"
[ "$(id -u)" -ne 0 ] || die "run as the dedicated non-root Host user"
[ -n "${HOME:-}" ] || die "HOME is required"
current_uid=$(id -u)

command=${1:-}
[ -n "$command" ] || usage
shift

xdg_data_home=${XDG_DATA_HOME:-$HOME/.local/share}
xdg_config_home=${XDG_CONFIG_HOME:-$HOME/.config}
install_root="$xdg_data_home/zapvm"
unit_dir="$xdg_config_home/systemd/user"
source_dir=
release_public_key=
daemon_config_source=
node_config_source=
start_services=true

while [ "$#" -gt 0 ]; do
    case "$1" in
        --source-dir)
            [ "$#" -ge 2 ] || usage
            source_dir=$2
            shift 2
            ;;
        --release-public-key)
            [ "$#" -ge 2 ] || usage
            release_public_key=$2
            shift 2
            ;;
        --daemon-config)
            [ "$#" -ge 2 ] || usage
            daemon_config_source=$2
            shift 2
            ;;
        --node-config)
            [ "$#" -ge 2 ] || usage
            node_config_source=$2
            shift 2
            ;;
        --install-root)
            [ "$#" -ge 2 ] || usage
            install_root=$2
            shift 2
            ;;
        --unit-dir)
            [ "$#" -ge 2 ] || usage
            unit_dir=$2
            shift 2
            ;;
        --no-start)
            start_services=false
            shift
            ;;
        *) usage ;;
    esac
done

require_command() {
    resolved=$(command -v "$1" 2>/dev/null || true)
    [ -n "$resolved" ] || die "required command is missing: $1"
    case "$resolved" in /*) ;; *) die "required command did not resolve to an absolute path: $1" ;; esac
    [ -f "$resolved" ] && [ ! -L "$resolved" ] || die "required command must be a real file: $resolved"
    owner=$(stat -c '%u' "$resolved")
    mode=$(stat -c '%a' "$resolved")
    [ "$owner" = 0 ] || die "required command is not root-owned: $resolved"
    case "$mode" in
        *[2367][0-9]|*[0-9][2367]) die "required command is group/other writable: $resolved" ;;
    esac
    printf '%s\n' "$resolved"
}

systemctl_bin=$(require_command systemctl)
systemd_run_bin=$(require_command systemd-run)
systemd_analyze_bin=$(require_command systemd-analyze)
loginctl_bin=$(require_command loginctl)
openssl_bin=$(require_command openssl)
sha256sum_bin=$(require_command sha256sum)
realpath_bin=$(require_command realpath)

reject_unsafe_text() {
    value=$1
    label=$2
    [ -n "$value" ] || die "$label is empty"
    case "$value" in
        *'
'*) die "$label contains a newline" ;;
    esac
}

require_absolute() {
    reject_unsafe_text "$1" "$2"
    case "$1" in /*) ;; *) die "$2 must be absolute" ;; esac
}

require_home_child() {
    require_absolute "$1" "$2"
    case "$1" in "$HOME"/*) ;; *) die "$2 must remain inside HOME" ;; esac
    canonical=$($realpath_bin -m -- "$1")
    [ "$canonical" = "$1" ] || die "$2 must be canonical and cannot resolve through a symlink"
}

require_managed_dir() {
    path=$1
    label=$2
    [ -d "$path" ] && [ ! -L "$path" ] || die "$label must be a real directory"
    [ "$(stat -c '%u' "$path")" = "$current_uid" ] || die "$label must be owned by the current user"
    mode=$(stat -c '%a' "$path")
    [ "$mode" = 700 ] || die "$label must have mode 0700 (found $mode)"
    physical=$($realpath_bin -e -- "$path")
    [ "$physical" = "$path" ] || die "$label resolves through a symlink"
}

require_unit_dir() {
    [ -d "$unit_dir" ] && [ ! -L "$unit_dir" ] || die "systemd user unit directory must be real"
    [ "$(stat -c '%u' "$unit_dir")" = "$current_uid" ] || die "systemd user unit directory must be owned by the current user"
    mode=$(stat -c '%a' "$unit_dir")
    case "$mode" in
        *[2367][0-9]|*[0-9][2367]) die "systemd user unit directory cannot be group/other writable" ;;
    esac
    physical=$($realpath_bin -e -- "$unit_dir")
    [ "$physical" = "$unit_dir" ] || die "systemd user unit directory resolves through a symlink"
}

require_regular_executable() {
    path=$1
    label=$2
    [ -f "$path" ] && [ ! -L "$path" ] && [ -x "$path" ] || die "$label must be a real executable file"
    [ "$(stat -c '%u' "$path")" = "$current_uid" ] || die "$label must be owned by the current user"
}

require_regular_file() {
    path=$1
    label=$2
    [ -f "$path" ] && [ ! -L "$path" ] || die "$label must be a real file"
}

require_owner_file_600() {
    require_regular_file "$1" "$2"
    [ "$(stat -c '%u' "$1")" = "$current_uid" ] || die "$2 must be owned by the current user"
    mode=$(stat -c '%a' "$1")
    [ "$mode" = 600 ] || die "$2 must have mode 0600 (found $mode)"
}

valid_version() {
    case "$1" in
        ''|*[!A-Za-z0-9._+-]*|.|..) return 1 ;;
        *) [ "${#1}" -le 128 ] ;;
    esac
}

config_dir="$install_root/config"
daemon_config="$config_dir/daemon.json"
node_config="$config_dir/cloud-node.json"
releases_dir="$install_root/releases"
logs_dir="$install_root/logs"
current_link="$install_root/current"
previous_link="$install_root/previous"
lock_dir="$install_root/.install.lock"
daemon_unit_path="$unit_dir/$daemon_unit"
node_unit_path="$unit_dir/$node_unit"

require_home_child "$install_root" "install root"
require_home_child "$unit_dir" "systemd user unit directory"

prepare_roots() {
    for directory in "$install_root" "$config_dir" "$releases_dir" "$logs_dir"; do
        if [ ! -d "$directory" ]; then
            [ ! -e "$directory" ] || die "managed path is not a directory: $directory"
            mkdir -p -- "$directory"
            chmod 700 "$directory"
        fi
        require_managed_dir "$directory" "managed directory $directory"
    done
    if [ ! -d "$unit_dir" ]; then
        [ ! -e "$unit_dir" ] || die "systemd user unit path is not a directory"
        mkdir -p -- "$unit_dir"
        chmod 700 "$unit_dir"
    fi
    require_unit_dir
}

acquire_lock() {
    if ! mkdir -m 700 -- "$lock_dir" 2>/dev/null; then
        die "another install operation is active; inspect $lock_dir before removing a stale lock"
    fi
    trap 'cleanup_lock' 0 1 2 3 15
}

cleanup_lock() {
    status=$?
    trap - 0 1 2 3 15
    rmdir -- "$lock_dir" 2>/dev/null || true
    exit "$status"
}

preflight_host() {
    candidate=${1:-}
    if [ -z "$candidate" ]; then
        [ -L "$current_link" ] || die "host is not installed"
        candidate="$current_link/zapvm"
    fi
    "$candidate" doctor || die "Linux Host prerequisites are not ready"
    systemd_version=$($systemd_run_bin --version | awk 'NR == 1 { print $2 }')
    case "$systemd_version" in ''|*[!0-9]*) die "cannot parse systemd version" ;; esac
    [ "$systemd_version" -ge 254 ] || die "systemd 254+ is required"
    [ -f /sys/fs/cgroup/cgroup.controllers ] || die "cgroup v2 is required"
    [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm must be readable and writable"
    "$systemctl_bin" --user show-environment >/dev/null || die "systemd user manager is unavailable"
    "$systemd_run_bin" --user --scope --quiet true >/dev/null || die "systemd user transient scopes are unavailable"
    linger=$($loginctl_bin show-user "$(id -u)" -p Linger --value 2>/dev/null || true)
    [ "$linger" = yes ] || die "loginctl linger must be enabled for the dedicated Host user"
}

verify_release_signature() {
    release=$1
    public_key=$2
    require_regular_file "$release/SHA256SUMS" "release checksum manifest"
    require_regular_file "$release/SHA256SUMS.sig" "release checksum signature"
    require_regular_file "$public_key" "release public key"
    [ "$(stat -c '%s' "$release/SHA256SUMS.sig")" -le 1024 ] || die "release signature is too large"
    "$openssl_bin" pkeyutl -verify -pubin -inkey "$public_key" -rawin \
        -in "$release/SHA256SUMS" -sigfile "$release/SHA256SUMS.sig" >/dev/null 2>&1 ||
        die "release checksum signature verification failed"
    [ "$(wc -l <"$release/SHA256SUMS" | tr -d ' ')" = 2 ] || die "release checksum manifest must contain exactly two lines"
    grep -Eq '^[0-9a-f]{64}  zapvm$' "$release/SHA256SUMS" || die "release checksum manifest is missing zapvm"
    grep -Eq '^[0-9a-f]{64}  zapvm-node$' "$release/SHA256SUMS" || die "release checksum manifest is missing zapvm-node"
    (cd "$release" && "$sha256sum_bin" -c SHA256SUMS >/dev/null) || die "release binary checksum verification failed"
}

validate_release() {
    release=$1
    public_key=$2
    require_regular_executable "$release/zapvm" "zapvm binary"
    require_regular_executable "$release/zapvm-node" "zapvm-node binary"
    verify_release_signature "$release" "$public_key"
    zapvm_version=$("$release/zapvm" version)
    node_version=$("$release/zapvm-node" --version)
    valid_version "$zapvm_version" || die "zapvm returned an invalid version"
    [ "$zapvm_version" = "$node_version" ] || die "zapvm and zapvm-node versions differ"
    printf '%s\n' "$zapvm_version"
}

same_hash() {
    [ "$("$sha256sum_bin" "$1" | awk '{print $1}')" = "$("$sha256sum_bin" "$2" | awk '{print $1}')" ]
}

stage_release() {
    require_absolute "$source_dir" "source directory"
    require_absolute "$release_public_key" "release public key"
    [ -d "$source_dir" ] && [ ! -L "$source_dir" ] || die "source directory must be real"
    source_version=$(validate_release "$source_dir" "$release_public_key")
    destination="$releases_dir/$source_version"
    if [ -e "$destination" ]; then
        require_managed_dir "$destination" "release directory $destination"
        for file in zapvm zapvm-node SHA256SUMS SHA256SUMS.sig release-public.pem; do
            source_file="$source_dir/$file"
            [ "$file" != release-public.pem ] || source_file=$release_public_key
            same_hash "$source_file" "$destination/$file" || die "release $source_version already exists with different content"
        done
        validate_release "$destination" "$destination/release-public.pem" >/dev/null
        printf '%s\n' "$source_version"
        return
    fi
    staging="$releases_dir/.$source_version.partial.$$"
    [ ! -e "$staging" ] || die "release staging path already exists"
    install -d -m 700 "$staging"
    install -m 755 "$source_dir/zapvm" "$staging/zapvm"
    install -m 755 "$source_dir/zapvm-node" "$staging/zapvm-node"
    install -m 600 "$source_dir/SHA256SUMS" "$staging/SHA256SUMS"
    install -m 600 "$source_dir/SHA256SUMS.sig" "$staging/SHA256SUMS.sig"
    install -m 600 "$release_public_key" "$staging/release-public.pem"
    validate_release "$staging" "$staging/release-public.pem" >/dev/null
    mv -- "$staging" "$destination"
    printf '%s\n' "$source_version"
}

validate_config_pair() {
    release=$1
    daemon_path=$2
    node_path=$3
    require_regular_file "$daemon_path" "daemon config"
    require_regular_file "$node_path" "node config"
    "$release/zapvm" daemon run --config "$daemon_path" --validate >/dev/null
    "$release/zapvm-node" --config "$node_path" --validate >/dev/null
    daemon_endpoint=$("$release/zapvm" daemon run --config "$daemon_path" --print-endpoint)
    node_endpoint=$("$release/zapvm-node" --config "$node_path" --print-daemon-endpoint)
    [ "$daemon_endpoint" = "$node_endpoint" ] || die "daemon and node configs use different IPC endpoints"
    [ -n "$daemon_endpoint" ] || die "Linux service configs must set an explicit daemon endpoint"
    case "$daemon_endpoint" in
        "$HOME"/*|"/run/user/$current_uid"/*) ;;
        *) die "daemon endpoint must remain inside HOME or /run/user/$current_uid" ;;
    esac
}

stage_configs() {
    release=$1
    require_absolute "$daemon_config_source" "daemon config source"
    require_absolute "$node_config_source" "node config source"
    require_regular_file "$daemon_config_source" "daemon config source"
    require_regular_file "$node_config_source" "node config source"
    daemon_temp="$config_dir/.daemon.$$.json"
    node_temp="$config_dir/.node.$$.json"
    install -m 600 "$daemon_config_source" "$daemon_temp"
    install -m 600 "$node_config_source" "$node_temp"
    validate_config_pair "$release" "$daemon_temp" "$node_temp"
}

systemd_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g'
}

render_units() {
    unit_staging="$install_root/.units.$$"
    [ ! -e "$unit_staging" ] || die "unit staging path already exists"
    mkdir -m 700 "$unit_staging"
    binary=$(systemd_escape "$current_link/zapvm")
    node_binary=$(systemd_escape "$current_link/zapvm-node")
    daemon_config_arg=$(systemd_escape "$daemon_config")
    node_config_arg=$(systemd_escape "$node_config")
    cat >"$unit_staging/$daemon_unit" <<EOF
[Unit]
Description=zapVM per-user Agent Computer daemon

[Service]
Type=simple
ExecStart="$binary" daemon run --config "$daemon_config_arg"
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=default.target
EOF
    cat >"$unit_staging/$node_unit" <<EOF
[Unit]
Description=zapVM cloud Agent Host node worker
After=network-online.target $daemon_unit
Wants=network-online.target $daemon_unit

[Service]
Type=simple
ExecStart="$node_binary" --config "$node_config_arg"
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=default.target
EOF
    chmod 600 "$unit_staging/$daemon_unit" "$unit_staging/$node_unit"
}

stop_services() {
    [ "$start_services" = true ] || return 0
    "$systemctl_bin" --user stop "$node_unit" "$daemon_unit" >/dev/null 2>&1 || true
}

reload_services() {
    [ "$start_services" = true ] || return 0
    "$systemctl_bin" --user daemon-reload
}

service_is_running() {
    service_name=$1
    active_state=$("$systemctl_bin" --user show "$service_name" -p ActiveState --value)
    sub_state=$("$systemctl_bin" --user show "$service_name" -p SubState --value)
    [ "$active_state" = active ] && [ "$sub_state" = running ]
}

start_and_check_services() {
    [ "$start_services" = true ] || return 0
    "$systemctl_bin" --user reset-failed "$daemon_unit" "$node_unit" >/dev/null 2>&1 || true
    "$systemctl_bin" --user enable "$daemon_unit" "$node_unit" >/dev/null || return 1
    "$systemctl_bin" --user start "$daemon_unit" || return 1
    deadline=$(( $(date +%s) + 30 ))
    while ! "$current_link/zapvm" daemon status --config "$daemon_config" >/dev/null 2>&1; do
        [ "$(date +%s)" -lt "$deadline" ] || return 1
        sleep 1
    done
    "$systemctl_bin" --user start "$node_unit" || return 1
    sleep 2
    service_is_running "$node_unit" || return 1
    node_restarts=$("$systemctl_bin" --user show "$node_unit" -p NRestarts --value)
    case "$node_restarts" in ''|*[!0-9]*) return 1 ;; esac
    [ "$node_restarts" -eq 0 ] || return 1
}

set_pointer() {
    link=$1
    target=$2
    temp="$install_root/.${link##*/}.$$"
    rm -f -- "$temp"
    ln -s -- "$target" "$temp"
    mv -Tf -- "$temp" "$link"
}

read_release_pointer() {
    link=$1
    if [ ! -L "$link" ]; then
        [ ! -e "$link" ] || die "release pointer is not a symlink: $link"
        return 1
    fi
    target=$(readlink -- "$link")
    case "$target" in releases/*) ;; *) die "unsafe release pointer: $link -> $target" ;; esac
    [ -d "$install_root/$target" ] && [ ! -L "$install_root/$target" ] || die "release pointer target is missing or unsafe"
    printf '%s\n' "$target"
}

install_or_upgrade() {
    [ -n "$source_dir" ] && [ -n "$release_public_key" ] && [ -n "$daemon_config_source" ] && [ -n "$node_config_source" ] || usage
    prepare_roots
    acquire_lock
    old_target=$(read_release_pointer "$current_link" 2>/dev/null || true)
    old_previous_target=$(read_release_pointer "$previous_link" 2>/dev/null || true)
    if [ "$command" = install ]; then
        [ -z "$old_target" ] || die "host is already installed; use upgrade"
        [ -z "$old_previous_target" ] || die "host has a previous pointer but no active release"
        for managed_file in "$daemon_config" "$node_config" "$daemon_unit_path" "$node_unit_path"; do
            [ ! -e "$managed_file" ] && [ ! -L "$managed_file" ] || die "refusing to replace pre-existing managed file during install: $managed_file"
        done
    else
        [ -n "$old_target" ] || die "host is not installed; use install"
    fi
    version=$(stage_release)
    new_target="releases/$version"
    [ "$new_target" != "$old_target" ] || die "version $version is already active"
    release="$install_root/$new_target"
    preflight_host "$release/zapvm"
    stage_configs "$release"
    render_units

    daemon_backup="$config_dir/.daemon.backup.$$"
    node_backup="$config_dir/.node.backup.$$"
    daemon_unit_backup="$install_root/.daemon.unit.backup.$$"
    node_unit_backup="$install_root/.node.unit.backup.$$"
    for managed_file in "$daemon_config" "$node_config" "$daemon_unit_path" "$node_unit_path"; do
        [ ! -L "$managed_file" ] || die "managed file cannot be a symlink: $managed_file"
        if [ -e "$managed_file" ]; then
            require_regular_file "$managed_file" "managed file"
            [ "$(stat -c '%u' "$managed_file")" = "$current_uid" ] || die "managed file must be owned by the current user"
        fi
    done
    [ ! -f "$daemon_config" ] || cp -p "$daemon_config" "$daemon_backup"
    [ ! -f "$node_config" ] || cp -p "$node_config" "$node_backup"
    [ ! -f "$daemon_unit_path" ] || cp -p "$daemon_unit_path" "$daemon_unit_backup"
    [ ! -f "$node_unit_path" ] || cp -p "$node_unit_path" "$node_unit_backup"

    stop_services
    mv -f "$config_dir/.daemon.$$.json" "$daemon_config"
    mv -f "$config_dir/.node.$$.json" "$node_config"
    mv -f "$install_root/.units.$$/$daemon_unit" "$daemon_unit_path"
    mv -f "$install_root/.units.$$/$node_unit" "$node_unit_path"
    rmdir "$install_root/.units.$$"
    [ -z "$old_target" ] || set_pointer "$previous_link" "$old_target"
    set_pointer "$current_link" "$new_target"
    reload_services

    if ! "$systemd_analyze_bin" --user verify "$daemon_unit_path" "$node_unit_path" >/dev/null || ! start_and_check_services; then
        stop_services
        if [ -n "$old_target" ]; then set_pointer "$current_link" "$old_target"; else rm -f "$current_link"; fi
        if [ -f "$daemon_backup" ]; then mv -f "$daemon_backup" "$daemon_config"; else rm -f "$daemon_config"; fi
        if [ -f "$node_backup" ]; then mv -f "$node_backup" "$node_config"; else rm -f "$node_config"; fi
        if [ -f "$daemon_unit_backup" ]; then mv -f "$daemon_unit_backup" "$daemon_unit_path"; else rm -f "$daemon_unit_path"; fi
        if [ -f "$node_unit_backup" ]; then mv -f "$node_unit_backup" "$node_unit_path"; else rm -f "$node_unit_path"; fi
        if [ -n "$old_previous_target" ]; then set_pointer "$previous_link" "$old_previous_target"; else rm -f "$previous_link"; fi
        reload_services
        if [ -n "$old_target" ]; then
            start_and_check_services || die "upgrade failed and previous services also failed to recover"
        else
            if [ "$start_services" = true ]; then
                "$systemctl_bin" --user disable "$daemon_unit" "$node_unit" >/dev/null 2>&1 || true
            fi
        fi
        die "service health check failed; previous release was restored"
    fi
    rm -f "$daemon_backup" "$node_backup" "$daemon_unit_backup" "$node_unit_backup"
    printf '%s\n' "ZAPVM_LINUX_HOST_OK action=$command version=$version root=$install_root"
}

rollback_host() {
    prepare_roots
    acquire_lock
    preflight_host ""
    current_target=$(read_release_pointer "$current_link") || die "host is not installed"
    previous_target=$(read_release_pointer "$previous_link") || die "no previous release is available"
    validate_release "$install_root/$previous_target" "$install_root/$previous_target/release-public.pem" >/dev/null
    validate_config_pair "$install_root/$previous_target" "$daemon_config" "$node_config"
    stop_services
    set_pointer "$current_link" "$previous_target"
    set_pointer "$previous_link" "$current_target"
    if ! start_and_check_services; then
        stop_services
        set_pointer "$current_link" "$current_target"
        set_pointer "$previous_link" "$previous_target"
        start_and_check_services || die "rollback failed and original services also failed to recover"
        die "rollback target failed health checks; original release was restored"
    fi
    printf '%s\n' "ZAPVM_LINUX_HOST_OK action=rollback version=${previous_target#releases/} root=$install_root"
}

doctor_host() {
    prepare_roots
    current_target=$(read_release_pointer "$current_link") || die "host is not installed"
    release="$install_root/$current_target"
    version=$(validate_release "$release" "$release/release-public.pem")
    validate_config_pair "$release" "$daemon_config" "$node_config"
    require_owner_file_600 "$daemon_config" "daemon config"
    require_owner_file_600 "$node_config" "node config"
    require_owner_file_600 "$daemon_unit_path" "daemon systemd unit"
    require_owner_file_600 "$node_unit_path" "node systemd unit"
    "$systemd_analyze_bin" --user verify "$daemon_unit_path" "$node_unit_path" >/dev/null
    if [ "$start_services" = true ]; then
        preflight_host ""
        "$release/zapvm" daemon status --config "$daemon_config" >/dev/null
        for unit in "$daemon_unit" "$node_unit"; do
            "$systemctl_bin" --user is-enabled --quiet "$unit"
            service_is_running "$unit"
        done
    fi
    printf '%s\n' "ZAPVM_LINUX_HOST_OK action=doctor version=$version root=$install_root"
}

uninstall_host() {
    [ -d "$install_root" ] || die "host is not installed"
    require_managed_dir "$install_root" "install root"
    [ ! -e "$unit_dir" ] || require_unit_dir
    acquire_lock
    for managed_file in "$daemon_unit_path" "$node_unit_path" "$current_link" "$previous_link"; do
        case "$managed_file" in "$current_link"|"$previous_link") ;; *) [ ! -L "$managed_file" ] || die "managed unit cannot be a symlink: $managed_file" ;; esac
    done
    if [ "$start_services" = true ]; then
        "$systemctl_bin" --user disable --now "$node_unit" "$daemon_unit" >/dev/null 2>&1 || true
    fi
    rm -f "$daemon_unit_path" "$node_unit_path" "$current_link" "$previous_link"
    reload_services
    printf '%s\n' "ZAPVM_LINUX_HOST_OK action=uninstall retained=$install_root"
}

case "$command" in
    install|upgrade) install_or_upgrade ;;
    rollback) rollback_host ;;
    doctor) doctor_host ;;
    uninstall) uninstall_host ;;
    *) usage ;;
esac
