#!/bin/sh
set -eu

lock_dir=${1:?usage: install-rootfs-packages.sh LOCK_DIRECTORY arm64|amd64}
target_arch=${2:?usage: install-rootfs-packages.sh LOCK_DIRECTORY arm64|amd64}
# The lock is a reviewed repository file, never downloaded from a package mirror.
# shellcheck disable=SC1091
. "$lock_dir/rootfs-lock.env"
case "$target_arch" in
    arm64) expected_hash=$APK_LOCK_ARM64_SHA256; expected_count=$APK_INSTALLED_ARM64_PACKAGES ;;
    amd64) expected_hash=$APK_LOCK_AMD64_SHA256; expected_count=$APK_INSTALLED_AMD64_PACKAGES ;;
    *) echo "unsupported architecture: $target_arch" >&2; exit 2 ;;
esac
lock_file="$lock_dir/rootfs-packages-$target_arch.lock"
if command -v sha256sum >/dev/null 2>&1; then
    actual_hash=$(sha256sum "$lock_file" | awk '{print $1}')
else
    actual_hash=$(shasum -a 256 "$lock_file" | awk '{print $1}')
fi
[ "$actual_hash" = "$expected_hash" ] || {
    echo "Alpine package input lock digest mismatch for $target_arch" >&2
    exit 1
}
# Check the entire closure before invoking apk. Bare names and range constraints
# would silently select new transitive dependencies from the moving repository.
awk -F= -v expected="$expected_count" '
    !/^[a-zA-Z0-9][a-zA-Z0-9+_.-]*=[0-9][a-zA-Z0-9+_.:~-]*$/ || seen[$1]++ { bad = 1 }
    END { exit (bad || NR != expected) ? 1 : 0 }
' "$lock_file" || {
    echo "invalid Alpine package input lock for $target_arch" >&2
    exit 1
}
[ "${3:-}" != --verify-only ] || exit 0
set --
while IFS= read -r package || [ -n "$package" ]; do
    set -- "$@" "$package"
done <"$lock_file"
# Keep Alpine signature verification enabled. Missing exact versions fail;
# there is deliberately no unpinned retry or automatic lock refresh.
exec apk add --no-cache "$@"
