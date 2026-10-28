#!/bin/sh
set -eu

lock_dir=${1:?usage: install-image-converter-packages.sh LOCK_DIRECTORY arm64\|amd64}
target_arch=${2:?usage: install-image-converter-packages.sh LOCK_DIRECTORY arm64\|amd64}
# shellcheck disable=SC1091
. "$lock_dir/runtime-lock.env"
case "$target_arch" in
    arm64) expected_lock=$CONVERTER_APK_LOCK_ARM64_SHA256; expected_installed=$CONVERTER_APK_INSTALLED_ARM64_SHA256; expected_count=$CONVERTER_APK_ARM64_PACKAGES ;;
    amd64) expected_lock=$CONVERTER_APK_LOCK_AMD64_SHA256; expected_installed=$CONVERTER_APK_INSTALLED_AMD64_SHA256; expected_count=$CONVERTER_APK_AMD64_PACKAGES ;;
    *) echo "unsupported converter architecture: $target_arch" >&2; exit 2 ;;
esac
lock_file="$lock_dir/converter-packages-$target_arch.lock"
hash_file() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}
[ "$(hash_file "$lock_file")" = "$expected_lock" ] || { echo "converter package lock digest mismatch" >&2; exit 1; }
awk -F= -v expected="$expected_count" '
    !/^[a-zA-Z0-9][a-zA-Z0-9+_.-]*=[0-9][a-zA-Z0-9+_.:~-]*$/ || seen[$1]++ { bad = 1 }
    END { exit (bad || NR != expected) ? 1 : 0 }
' "$lock_file" || { echo "invalid converter package lock" >&2; exit 1; }
[ "${3:-}" != --verify-only ] || exit 0
set --
while IFS= read -r package || [ -n "$package" ]; do set -- "$@" "$package"; done <"$lock_file"
apk add --no-cache "$@"
installed=/lib/apk/db/installed
[ "$(hash_file "$installed")" = "$expected_installed" ] || { echo "converter package closure digest mismatch" >&2; exit 1; }
[ "$(grep -c '^P:' "$installed")" = "$expected_count" ] || { echo "converter package closure count mismatch" >&2; exit 1; }
