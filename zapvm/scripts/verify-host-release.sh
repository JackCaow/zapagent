#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: $0 <archive.tar.gz> <version>" >&2
    exit 2
fi

archive=$1
version=${2#v}
case "$version" in
    ''|*[!0-9A-Za-z.+-]*) echo "invalid version: $version" >&2; exit 2 ;;
esac
[ -f "$archive" ] || { echo "archive not found: $archive" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive_name=${archive##*/}
archive_base=${archive_name%.tar.gz}
[ "$archive_base" != "$archive_name" ] || { echo "expected a .tar.gz Host archive" >&2; exit 2; }

temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

tar -tzf "$archive" | awk '
    /^\// || /(^|\/)\.\.($|\/)/ { bad = 1 }
    END { exit bad }
' || { echo "archive contains an unsafe path" >&2; exit 1; }
tar -C "$temporary_directory" -xzf "$archive"
package_root="$temporary_directory/$archive_base"
[ -d "$package_root" ] || { echo "package root is missing: $archive_base" >&2; exit 1; }
if find "$package_root" -type l -print | grep -q .; then
    echo "archive contains a symlink" >&2
    exit 1
fi

for binary in zapvm zapvm-node zapvm-agent-adapter zapvm-image zapvm-sbom zapvm-host-install; do
    [ -f "$package_root/$binary" ] || { echo "package is missing $binary" >&2; exit 1; }
    [ ! -L "$package_root/$binary" ] || { echo "$binary must not be a symlink" >&2; exit 1; }
    [ -x "$package_root/$binary" ] || { echo "$binary is not executable" >&2; exit 1; }
done

[ "$($package_root/zapvm version)" = "$version" ] || { echo "zapvm version mismatch" >&2; exit 1; }
[ "$($package_root/zapvm-node --version)" = "$version" ] || { echo "zapvm-node version mismatch" >&2; exit 1; }
[ "$($package_root/zapvm-agent-adapter version)" = "$version" ] || { echo "zapvm-agent-adapter version mismatch" >&2; exit 1; }

assert_cli_error() {
    executable=$1
    expected_status=$2
    expected_marker=$3
    shift 3
    set +e
    cli_output=$("$executable" "$@" 2>&1)
    cli_status=$?
    set -e
    [ "$cli_status" -eq "$expected_status" ] || { echo "$executable error exit=$cli_status, want $expected_status" >&2; exit 1; }
    printf '%s\n' "$cli_output" | grep -Fq "$expected_marker" || { echo "$executable is missing $expected_marker" >&2; exit 1; }
}
assert_cli_error "$package_root/zapvm" 64 'ZAPVM_ERROR[invalid_request]' not-a-command
assert_cli_error "$package_root/zapvm-image" 64 'ZAPVM_ERROR[invalid_request]'
assert_cli_error "$package_root/zapvm-node" 78 'ZAPVM_ERROR[invalid_configuration]'
assert_cli_error "$package_root/zapvm-sbom" 78 'ZAPVM_ERROR[invalid_configuration]'

for file in LICENSE NOTICE THIRD_PARTY_NOTICES.md README.md; do
    [ -f "$package_root/$file" ] || { echo "package is missing $file" >&2; exit 1; }
done
for file in installation.md host-install-macos.md host-install-linux.md host-install-windows.md node-operations.md agent-integration.md diagnostics.md error-taxonomy.md layered-image-delivery.md; do
    cmp -s "$repo_root/docs/$file" "$package_root/docs/$file" || { echo "packaged docs/$file differs from source" >&2; exit 1; }
done
for file in daemon.json cloud-node.json cloud-node-managed.json; do
    cmp -s "$repo_root/packaging/examples/$file" "$package_root/examples/$file" || { echo "packaged examples/$file differs from source" >&2; exit 1; }
done

host_os=$(uname -s)
case "$host_os" in
    Darwin)
        cmp -s "$repo_root/scripts/zapvm-host-macos.sh" "$package_root/zapvm-host-install" || { echo "wrong macOS Host installer" >&2; exit 1; }
        codesign --verify --strict "$package_root/zapvm"
        codesign --verify --strict "$package_root/zapvm-node"
        codesign --verify --strict "$package_root/zapvm-agent-adapter"
        entitlements=$(codesign -d --entitlements :- "$package_root/zapvm" 2>/dev/null)
        printf '%s\n' "$entitlements" | grep -q 'com.apple.security.virtualization' || { echo "zapvm is missing the virtualization entitlement" >&2; exit 1; }
        ;;
    Linux)
        cmp -s "$repo_root/scripts/zapvm-host-linux.sh" "$package_root/zapvm-host-install" || { echo "wrong Linux Host installer" >&2; exit 1; }
        ;;
    *) echo "unsupported verification host: $host_os" >&2; exit 2 ;;
esac

sh -n "$package_root/zapvm-host-install"
echo "HOST_RELEASE_OK archive=$archive_name version=$version"
