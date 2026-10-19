#!/bin/sh
set -eu

if [ "$#" -lt 6 ] || [ "$#" -gt 8 ]; then
    echo "usage: $0 <evidence-dir> <version> <bundle> <public-key> <bundle-sha256> <public-key-sha256> [host-archive] [host-sha256]" >&2
    exit 2
fi

evidence_dir=$1
version=${2#v}
bundle=$3
public_key=$4
bundle_sha256=$5
public_key_sha256=$6
host_archive=${7:-}
host_sha256=${8:-}

case "$version" in
    ''|*[!0-9A-Za-z.+-]*) echo "invalid candidate version: $version" >&2; exit 2 ;;
esac
case "$bundle_sha256:$public_key_sha256" in
    *[!0-9a-f:]*|*:*:*|:) echo "candidate SHA-256 values must be lowercase hexadecimal" >&2; exit 2 ;;
esac
[ "${#bundle_sha256}" -eq 64 ] && [ "${#public_key_sha256}" -eq 64 ] || {
    echo "candidate SHA-256 values must contain exactly 64 characters" >&2
    exit 2
}
if [ -n "$host_archive" ]; then
    [ -n "$host_sha256" ] || { echo "host-sha256 is required with host-archive" >&2; exit 2; }
    case "$host_sha256" in
        *[!0-9a-f]*) echo "host SHA-256 must be lowercase hexadecimal" >&2; exit 2 ;;
    esac
    [ "${#host_sha256}" -eq 64 ] || { echo "host SHA-256 must contain exactly 64 characters" >&2; exit 2; }
elif [ -n "$host_sha256" ]; then
    echo "host-archive is required with host-sha256" >&2
    exit 2
fi

[ "$(uname -s)" = Linux ] || { echo "native Linux acceptance requires a Linux Host" >&2; exit 2; }
[ "$(uname -m)" = x86_64 ] || { echo "this candidate requires an amd64 Linux Host" >&2; exit 2; }
[ "$(id -u)" -ne 0 ] || { echo "native Linux acceptance must run as a non-root login user" >&2; exit 2; }

for candidate_path in "$evidence_dir" "$bundle" "$public_key"; do
    case "$candidate_path" in
        /*) ;;
        *) echo "all paths must be absolute: $candidate_path" >&2; exit 2 ;;
    esac
done
[ ! -e "$evidence_dir" ] || { echo "refusing existing evidence directory: $evidence_dir" >&2; exit 2; }
for candidate_file in "$bundle" "$public_key"; do
    [ -f "$candidate_file" ] && [ ! -L "$candidate_file" ] || {
        echo "candidate must be a regular non-symlink file: $candidate_file" >&2
        exit 1
    }
done
if [ -n "$host_archive" ]; then
    case "$host_archive" in
        /*) ;;
        *) echo "host archive path must be absolute" >&2; exit 2 ;;
    esac
    [ -f "$host_archive" ] && [ ! -L "$host_archive" ] || {
        echo "Host archive must be a regular non-symlink file: $host_archive" >&2
        exit 1
    }
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_staging=$(mktemp -d "${TMPDIR:-/tmp}/zapvm-native-linux-package.XXXXXX")
trap 'rm -rf "$package_staging"' EXIT HUP INT TERM
mkdir -p "$evidence_dir"

if ! "$repo_dir/scripts/preflight-self-hosted-unix.sh" linux-multi >"$evidence_dir/host-preflight.log" 2>&1; then
    cat "$evidence_dir/host-preflight.log" >&2
    exit 1
fi
cat "$evidence_dir/host-preflight.log"

printf '%s  %s\n' "$bundle_sha256" "$bundle" | sha256sum -c -
printf '%s  %s\n' "$public_key_sha256" "$public_key" | sha256sum -c -

if [ -z "$host_archive" ]; then
    release_dir="$evidence_dir/release"
    mkdir -p "$release_dir"
    "$repo_dir/scripts/package-host-release.sh" "$version" "$release_dir"
    host_archive="$release_dir/zapvm_${version}_linux_amd64.tar.gz"
    host_sha256=$(sha256sum "$host_archive" | awk '{print $1}')
else
    printf '%s  %s\n' "$host_sha256" "$host_archive" | sha256sum -c -
fi
"$repo_dir/scripts/verify-host-release.sh" "$host_archive" "$version"

if tar -tzf "$host_archive" | awk '/^\// || /(^|\/)\.\.($|\/)/ { bad = 1 } END { exit bad }'; then
    :
else
    echo "Host archive contains an unsafe path" >&2
    exit 1
fi
tar -C "$package_staging" -xzf "$host_archive"
package="$package_staging/zapvm_${version}_linux_amd64"
[ -x "$package/zapvm" ] && [ -x "$package/zapvm-image" ] || {
    echo "Host package is missing executable zapvm or zapvm-image" >&2
    exit 1
}
if find "$package" -type l -print | grep -q .; then
    echo "Host package contains a symlink" >&2
    exit 1
fi

source_commit=unavailable
if command -v git >/dev/null 2>&1 && git -C "$repo_dir" rev-parse HEAD >/dev/null 2>&1; then
    source_commit=$(git -C "$repo_dir" rev-parse HEAD)
fi
printf 'target=linux-kvm\nsource_commit=%s\ncandidate_version=%s\nbundle=%s\nbundle_sha256=%s\npublic_key=%s\npublic_key_sha256=%s\nhost_archive=%s\nhost_sha256=%s\n' \
    "$source_commit" "$version" "$bundle" "$bundle_sha256" "$public_key" "$public_key_sha256" \
    "$host_archive" "$host_sha256" >"$evidence_dir/candidate-identity.txt"

ZAPVM_ACCEPTANCE_IMAGE_BUNDLE="$bundle" \
ZAPVM_ACCEPTANCE_IMAGE_PUBLIC_KEY="$public_key" \
ZAPVM_ACCEPTANCE_ZAPVM="$package/zapvm" \
ZAPVM_ACCEPTANCE_IMAGE_TOOL="$package/zapvm-image" \
    "$repo_dir/scripts/acceptance-linux.sh" "$evidence_dir/complete"

printf 'NATIVE_CANDIDATE_ACCEPTANCE_OK target=linux-kvm evidence=%s\n' "$evidence_dir" |
    tee "$evidence_dir/result.txt"
