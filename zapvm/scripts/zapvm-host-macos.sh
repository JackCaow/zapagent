#!/bin/sh
set -eu

umask 077

daemon_label=com.zapvm.daemon
node_label=com.zapvm.node

die() {
    printf '%s\n' "zapvm-host-macos: $*" >&2
    exit 1
}

usage() {
    cat >&2 <<'EOF'
usage:
  zapvm-host-macos.sh install|upgrade \
    --source-dir DIR --daemon-config FILE --node-config FILE \
    [--install-root DIR] [--launch-agents DIR] [--no-start]
  zapvm-host-macos.sh rollback|doctor|uninstall \
    [--install-root DIR] [--launch-agents DIR] [--no-start]

The installer is user-scoped. uninstall disables services and removes only the
active/previous pointers and managed LaunchAgents; releases, config, logs, VM
state, Computer state, and credentials are retained for recovery.
EOF
    exit 2
}

[ "$(/usr/bin/uname -s)" = Darwin ] || die "macOS is required"
[ "$(/usr/bin/id -u)" -ne 0 ] || die "run as the target login user, not root"
[ -n "${HOME:-}" ] || die "HOME is required"

command=${1:-}
[ -n "$command" ] || usage
shift

install_root="$HOME/Library/Application Support/zapvm"
launch_agents="$HOME/Library/LaunchAgents"
source_dir=
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
        --launch-agents)
            [ "$#" -ge 2 ] || usage
            launch_agents=$2
            shift 2
            ;;
        --no-start)
            start_services=false
            shift
            ;;
        *) usage ;;
    esac
done

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
    case "$1" in
        /*) ;;
        *) die "$2 must be absolute" ;;
    esac
}

require_home_child() {
    require_absolute "$1" "$2"
    case "$1" in
        "$HOME"/*) ;;
        *) die "$2 must remain inside HOME" ;;
    esac
}

require_real_parent() {
    path=$1
    label=$2
    parent=${path%/*}
    name=${path##*/}
    [ "$parent" != "$path" ] || die "$label has no parent"
    [ "$name" != . ] && [ "$name" != .. ] && [ -n "$name" ] || die "$label has an unsafe basename"
    [ -d "$parent" ] && [ ! -L "$parent" ] || die "$label parent must be an existing real directory"
    physical_parent=$(cd "$parent" && /bin/pwd -P)
    [ "$physical_parent" = "$parent" ] || die "$label parent resolves through a symlink or non-canonical path"
}

require_managed_dir() {
    path=$1
    label=$2
    [ -d "$path" ] && [ ! -L "$path" ] || die "$label must be a real directory"
    [ -O "$path" ] || die "$label must be owned by the current user"
    mode=$(/usr/bin/stat -f '%Lp' "$path")
    [ "$mode" = 700 ] || die "$label must have mode 0700 (found $mode)"
}

require_regular_executable() {
    path=$1
    label=$2
    [ -f "$path" ] && [ ! -L "$path" ] && [ -x "$path" ] || die "$label must be a real executable file"
    [ -O "$path" ] || die "$label must be owned by the current user"
}

require_regular_file() {
    path=$1
    label=$2
    [ -f "$path" ] && [ ! -L "$path" ] || die "$label must be a real file"
}

require_owner_file_600() {
    require_regular_file "$1" "$2"
    [ -O "$1" ] || die "$2 must be owned by the current user"
    mode=$(/usr/bin/stat -f '%Lp' "$1")
    [ "$mode" = 600 ] || die "$2 must have mode 0600 (found $mode)"
}

valid_version() {
    case "$1" in
        ''|*[!A-Za-z0-9._+-]*) return 1 ;;
        .|..) return 1 ;;
        *) [ "${#1}" -le 128 ] ;;
    esac
}

xml_escape() {
    printf '%s' "$1" | /usr/bin/sed \
        -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
        -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

domain="gui/$(/usr/bin/id -u)"
daemon_plist="$launch_agents/$daemon_label.plist"
node_plist="$launch_agents/$node_label.plist"
config_dir="$install_root/config"
daemon_config="$config_dir/daemon.json"
node_config="$config_dir/cloud-node.json"
releases_dir="$install_root/releases"
logs_dir="$install_root/logs"
current_link="$install_root/current"
previous_link="$install_root/previous"
lock_dir="$install_root/.install.lock"

require_home_child "$install_root" "install root"
require_home_child "$launch_agents" "LaunchAgents directory"

prepare_roots() {
    if [ ! -d "$launch_agents" ]; then
        require_real_parent "$launch_agents" "LaunchAgents directory"
        /usr/bin/install -d -m 700 "$launch_agents"
    fi
    require_managed_dir "$launch_agents" "LaunchAgents directory"
    if [ ! -d "$install_root" ]; then
        require_real_parent "$install_root" "install root"
        /usr/bin/install -d -m 700 "$install_root"
    fi
    require_managed_dir "$install_root" "install root"
    for directory in "$config_dir" "$releases_dir" "$logs_dir"; do
        if [ ! -d "$directory" ]; then
            [ ! -e "$directory" ] || die "managed path is not a directory: $directory"
            /usr/bin/install -d -m 700 "$directory"
        fi
        require_managed_dir "$directory" "managed directory $directory"
    done
}

acquire_lock() {
    if ! /bin/mkdir -m 700 "$lock_dir" 2>/dev/null; then
        die "another install operation is active; inspect $lock_dir before removing a stale lock"
    fi
    trap 'cleanup_lock' 0 1 2 3 15
}

cleanup_lock() {
    status=$?
    trap - 0 1 2 3 15
    /bin/rmdir "$lock_dir" 2>/dev/null || true
    exit "$status"
}

verify_codesign() {
    binary=$1
    /usr/bin/codesign --verify --strict --verbose=2 "$binary" >/dev/null 2>&1 || die "code signature verification failed: $binary"
}

verify_virtualization_entitlement() {
    binary=$1
    entitlements="$install_root/.entitlements.$$"
    /usr/bin/codesign -d --entitlements :- "$binary" >"$entitlements" 2>/dev/null || die "cannot inspect zapvm entitlements"
    value=$(/usr/bin/plutil -convert json -o - "$entitlements" 2>/dev/null || true)
    /bin/rm -f "$entitlements"
    printf '%s\n' "$value" | /usr/bin/grep -Eq '"com\.apple\.security\.virtualization"[[:space:]]*:[[:space:]]*true' ||
        die "zapvm binary lacks com.apple.security.virtualization=true"
}

validate_release() {
    release=$1
    require_regular_executable "$release/zapvm" "zapvm binary"
    require_regular_executable "$release/zapvm-node" "zapvm-node binary"
    verify_codesign "$release/zapvm"
    verify_codesign "$release/zapvm-node"
    verify_virtualization_entitlement "$release/zapvm"
    zapvm_version=$("$release/zapvm" version)
    node_version=$("$release/zapvm-node" --version)
    valid_version "$zapvm_version" || die "zapvm returned an invalid version"
    [ "$zapvm_version" = "$node_version" ] || die "zapvm and zapvm-node versions differ"
    printf '%s\n' "$zapvm_version"
}

same_file_hash() {
    [ "$(/usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}')" = "$(/usr/bin/shasum -a 256 "$2" | /usr/bin/awk '{print $1}')" ]
}

stage_release() {
    require_absolute "$source_dir" "source directory"
    [ -d "$source_dir" ] && [ ! -L "$source_dir" ] || die "source directory must be real"
    source_version=$(validate_release "$source_dir")
    destination="$releases_dir/$source_version"
    if [ -e "$destination" ]; then
        [ -d "$destination" ] && [ ! -L "$destination" ] || die "existing release path is unsafe"
        require_managed_dir "$destination" "release directory $destination"
        same_file_hash "$source_dir/zapvm" "$destination/zapvm" &&
            same_file_hash "$source_dir/zapvm-node" "$destination/zapvm-node" ||
            die "release $source_version already exists with different binaries"
        validate_release "$destination" >/dev/null
        printf '%s\n' "$source_version"
        return
    fi
    staging="$releases_dir/.$source_version.partial.$$"
    [ ! -e "$staging" ] || die "release staging path already exists"
    /usr/bin/install -d -m 700 "$staging"
    /usr/bin/install -m 755 "$source_dir/zapvm" "$staging/zapvm"
    /usr/bin/install -m 755 "$source_dir/zapvm-node" "$staging/zapvm-node"
    validate_release "$staging" >/dev/null
    /bin/mv "$staging" "$destination"
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
    daemon_endpoint=$(/usr/bin/plutil -extract endpoint raw -o - "$daemon_path" 2>/dev/null || true)
    node_endpoint=$(/usr/bin/plutil -extract daemon_endpoint raw -o - "$node_path" 2>/dev/null || true)
    [ "$daemon_endpoint" = "$node_endpoint" ] || die "daemon and node configs use different IPC endpoints"
}

stage_configs() {
    release=$1
    require_absolute "$daemon_config_source" "daemon config source"
    require_absolute "$node_config_source" "node config source"
    daemon_temp="$config_dir/.daemon.$$.json"
    node_temp="$config_dir/.node.$$.json"
    /usr/bin/install -m 600 "$daemon_config_source" "$daemon_temp"
    /usr/bin/install -m 600 "$node_config_source" "$node_temp"
    validate_config_pair "$release" "$daemon_temp" "$node_temp"
}

render_plists() {
    daemon_binary=$(xml_escape "$current_link/zapvm")
    node_binary=$(xml_escape "$current_link/zapvm-node")
    daemon_config_xml=$(xml_escape "$daemon_config")
    node_config_xml=$(xml_escape "$node_config")
    daemon_stdout=$(xml_escape "$logs_dir/daemon.stdout.log")
    daemon_stderr=$(xml_escape "$logs_dir/daemon.stderr.log")
    node_stdout=$(xml_escape "$logs_dir/node.stdout.log")
    node_stderr=$(xml_escape "$logs_dir/node.stderr.log")
    daemon_temp="$launch_agents/.$daemon_label.$$.plist"
    node_temp="$launch_agents/.$node_label.$$.plist"
    /bin/cat >"$daemon_temp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$daemon_label</string>
<key>ProgramArguments</key><array><string>$daemon_binary</string><string>daemon</string><string>run</string><string>--config</string><string>$daemon_config_xml</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>$daemon_stdout</string><key>StandardErrorPath</key><string>$daemon_stderr</string>
</dict></plist>
EOF
    /bin/cat >"$node_temp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$node_label</string>
<key>ProgramArguments</key><array><string>$node_binary</string><string>--config</string><string>$node_config_xml</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>$node_stdout</string><key>StandardErrorPath</key><string>$node_stderr</string>
</dict></plist>
EOF
    /usr/bin/plutil -lint "$daemon_temp" >/dev/null
    /usr/bin/plutil -lint "$node_temp" >/dev/null
}

stop_services() {
    /bin/launchctl bootout "$domain" "$node_plist" >/dev/null 2>&1 || true
    /bin/launchctl bootout "$domain" "$daemon_plist" >/dev/null 2>&1 || true
}

daemon_status() {
    configured_endpoint=$(/usr/bin/plutil -extract endpoint raw -o - "$daemon_config" 2>/dev/null || true)
    if [ -n "$configured_endpoint" ]; then
        "$current_link/zapvm" daemon status --endpoint "$configured_endpoint"
    else
        "$current_link/zapvm" daemon status
    fi
}

start_and_check_services() {
    [ "$start_services" = true ] || return 0
    /bin/launchctl bootstrap "$domain" "$daemon_plist"
    deadline=$(( $(/bin/date +%s) + 30 ))
    while ! daemon_status >/dev/null 2>&1; do
        [ "$(/bin/date +%s)" -lt "$deadline" ] || return 1
        /bin/sleep 1
    done
    /bin/launchctl bootstrap "$domain" "$node_plist"
    /bin/launchctl print "$domain/$node_label" >/dev/null
}

set_pointer() {
    link=$1
    target=$2
    temp="$install_root/.${link##*/}.$$"
    /bin/rm -f "$temp"
    /bin/ln -s "$target" "$temp"
    # BSD mv otherwise follows an existing symlink-to-directory and moves the
    # temporary link inside the old release instead of replacing the pointer.
    /bin/mv -f -h "$temp" "$link"
}

read_release_pointer() {
    link=$1
    if [ ! -L "$link" ]; then
        [ ! -e "$link" ] || die "release pointer is not a symlink: $link"
        return 1
    fi
    target=$(/usr/bin/readlink "$link")
    case "$target" in
        releases/*) ;;
        *) die "unsafe release pointer: $link -> $target" ;;
    esac
    [ -d "$install_root/$target" ] && [ ! -L "$install_root/$target" ] || die "release pointer target is missing or unsafe"
    printf '%s\n' "$target"
}

install_or_upgrade() {
    [ -n "$source_dir" ] && [ -n "$daemon_config_source" ] && [ -n "$node_config_source" ] || usage
    prepare_roots
    acquire_lock
    old_target=$(read_release_pointer "$current_link" 2>/dev/null || true)
    old_previous_target=$(read_release_pointer "$previous_link" 2>/dev/null || true)
    if [ "$command" = install ]; then
        [ -z "$old_target" ] || die "host is already installed; use upgrade"
        [ -z "$old_previous_target" ] || die "host has a previous pointer but no active release"
    else
        [ -n "$old_target" ] || die "host is not installed; use install"
    fi
    version=$(stage_release)
    new_target="releases/$version"
    [ "$new_target" != "$old_target" ] || die "version $version is already active"
    release="$install_root/$new_target"
    stage_configs "$release"
    render_plists

    daemon_backup="$config_dir/.daemon.backup.$$"
    node_backup="$config_dir/.node.backup.$$"
    daemon_plist_backup="$install_root/.daemon.plist.backup.$$"
    node_plist_backup="$install_root/.node.plist.backup.$$"
    for managed_file in "$daemon_config" "$node_config" "$daemon_plist" "$node_plist"; do
        [ ! -L "$managed_file" ] || die "managed file cannot be a symlink: $managed_file"
        if [ -e "$managed_file" ]; then
            require_regular_file "$managed_file" "managed file"
            [ -O "$managed_file" ] || die "managed file must be owned by the current user"
        fi
    done
    [ ! -f "$daemon_config" ] || /bin/cp -p "$daemon_config" "$daemon_backup"
    [ ! -f "$node_config" ] || /bin/cp -p "$node_config" "$node_backup"
    [ ! -f "$daemon_plist" ] || /bin/cp -p "$daemon_plist" "$daemon_plist_backup"
    [ ! -f "$node_plist" ] || /bin/cp -p "$node_plist" "$node_plist_backup"

    stop_services
    /bin/mv -f "$config_dir/.daemon.$$.json" "$daemon_config"
    /bin/mv -f "$config_dir/.node.$$.json" "$node_config"
    /bin/mv -f "$launch_agents/.$daemon_label.$$.plist" "$daemon_plist"
    /bin/mv -f "$launch_agents/.$node_label.$$.plist" "$node_plist"
    [ -z "$old_target" ] || set_pointer "$previous_link" "$old_target"
    set_pointer "$current_link" "$new_target"

    if ! start_and_check_services; then
        stop_services
        if [ -n "$old_target" ]; then
            set_pointer "$current_link" "$old_target"
        else
            /bin/rm -f "$current_link"
        fi
        if [ -f "$daemon_backup" ]; then /bin/mv -f "$daemon_backup" "$daemon_config"; else /bin/rm -f "$daemon_config"; fi
        if [ -f "$node_backup" ]; then /bin/mv -f "$node_backup" "$node_config"; else /bin/rm -f "$node_config"; fi
        if [ -f "$daemon_plist_backup" ]; then /bin/mv -f "$daemon_plist_backup" "$daemon_plist"; else /bin/rm -f "$daemon_plist"; fi
        if [ -f "$node_plist_backup" ]; then /bin/mv -f "$node_plist_backup" "$node_plist"; else /bin/rm -f "$node_plist"; fi
        if [ -n "$old_previous_target" ]; then
            set_pointer "$previous_link" "$old_previous_target"
        else
            /bin/rm -f "$previous_link"
        fi
        if [ -n "$old_target" ]; then
            start_and_check_services || die "upgrade failed and previous services also failed to recover"
        fi
        die "service health check failed; previous release was restored"
    fi
    /bin/rm -f "$daemon_backup" "$node_backup" "$daemon_plist_backup" "$node_plist_backup"
    printf '%s\n' "ZAPVM_MACOS_HOST_OK action=$command version=$version root=$install_root"
}

rollback_host() {
    prepare_roots
    acquire_lock
    current_target=$(read_release_pointer "$current_link") || die "host is not installed"
    previous_target=$(read_release_pointer "$previous_link") || die "no previous release is available"
    [ "$current_target" != "$previous_target" ] || die "current and previous releases are identical"
    validate_release "$install_root/$previous_target" >/dev/null
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
    printf '%s\n' "ZAPVM_MACOS_HOST_OK action=rollback version=${previous_target#releases/} root=$install_root"
}

doctor_host() {
    prepare_roots
    current_target=$(read_release_pointer "$current_link") || die "host is not installed"
    release="$install_root/$current_target"
    version=$(validate_release "$release")
    validate_config_pair "$release" "$daemon_config" "$node_config"
    require_owner_file_600 "$daemon_config" "daemon config"
    require_owner_file_600 "$node_config" "node config"
    require_owner_file_600 "$daemon_plist" "daemon LaunchAgent"
    require_owner_file_600 "$node_plist" "node LaunchAgent"
    /usr/bin/plutil -lint "$daemon_plist" >/dev/null
    /usr/bin/plutil -lint "$node_plist" >/dev/null
    if [ "$start_services" = true ]; then
        daemon_status >/dev/null
        /bin/launchctl print "$domain/$node_label" >/dev/null
    fi
    printf '%s\n' "ZAPVM_MACOS_HOST_OK action=doctor version=$version root=$install_root"
}

uninstall_host() {
    [ -d "$install_root" ] || die "host is not installed"
    require_managed_dir "$install_root" "install root"
    if [ -e "$launch_agents" ]; then
        require_managed_dir "$launch_agents" "LaunchAgents directory"
    fi
    acquire_lock
    stop_services
    /bin/rm -f "$daemon_plist" "$node_plist" "$current_link" "$previous_link"
    printf '%s\n' "ZAPVM_MACOS_HOST_OK action=uninstall retained=$install_root"
}

case "$command" in
    install|upgrade) install_or_upgrade ;;
    rollback) rollback_host ;;
    doctor) doctor_host ;;
    uninstall) uninstall_host ;;
    *) usage ;;
esac
