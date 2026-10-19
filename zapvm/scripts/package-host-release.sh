#!/bin/sh
set -eu
umask 022
export COPYFILE_DISABLE=1

if [ "$#" -ne 2 ]; then
    echo "usage: $0 <version> <output-directory>" >&2
    exit 2
fi

version=${1#v}
output_directory=$2
case "$version" in
    ''|*[!0-9A-Za-z.+-]*)
        echo "invalid release version: $version" >&2
        exit 2
        ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

host_os=$(go env GOOS)
host_arch=$(go env GOARCH)
case "$host_os" in
    darwin|linux) ;;
    *) echo "package-host-release.sh supports darwin and linux" >&2; exit 2 ;;
esac
case "$host_arch" in
    amd64|arm64) ;;
    *) echo "unsupported host architecture: $host_arch" >&2; exit 2 ;;
esac

archive_base="zapvm_${version}_${host_os}_${host_arch}"
staging_root=$(mktemp -d)
trap 'rm -rf "$staging_root"' EXIT HUP INT TERM
package_root="$staging_root/$archive_base"
mkdir -p "$package_root/docs" "$package_root/examples" "$output_directory"

go build -trimpath -ldflags "-X main.version=$version" -o "$package_root/zapvm" ./cmd/zapvm
go build -trimpath -ldflags "-X main.version=$version" -o "$package_root/zapvm-node" ./cmd/zapvm-node
go build -trimpath -ldflags "-X main.version=$version" -o "$package_root/zapvm-agent-adapter" ./cmd/zapvm-agent-adapter
go build -trimpath -o "$package_root/zapvm-image" ./cmd/zapvm-image
go build -trimpath -o "$package_root/zapvm-sbom" ./cmd/zapvm-sbom

if [ "$host_os" = darwin ]; then
    macos_sign_identity=${ZAPVM_MACOS_SIGN_IDENTITY:--}
    codesign --force --sign "$macos_sign_identity" --entitlements packaging/macos/zapvm.entitlements "$package_root/zapvm"
    codesign --force --sign "$macos_sign_identity" "$package_root/zapvm-node"
    codesign --force --sign "$macos_sign_identity" "$package_root/zapvm-agent-adapter"
    cp scripts/zapvm-host-macos.sh "$package_root/zapvm-host-install"
else
    cp scripts/zapvm-host-linux.sh "$package_root/zapvm-host-install"
fi
chmod 0755 "$package_root/zapvm-host-install"

cp LICENSE NOTICE THIRD_PARTY_NOTICES.md README.md "$package_root/"
cp docs/installation.md \
    docs/host-install-macos.md \
    docs/host-install-linux.md \
    docs/host-install-windows.md \
    docs/node-operations.md \
    docs/agent-integration.md \
    docs/diagnostics.md \
    docs/error-taxonomy.md \
    docs/layered-image-delivery.md \
    "$package_root/docs/"
cp packaging/examples/daemon.json \
    packaging/examples/cloud-node.json \
    packaging/examples/cloud-node-managed.json \
    "$package_root/examples/"
archive="$output_directory/$archive_base.tar.gz"
[ ! -e "$archive" ] || { echo "refusing existing Host archive: $archive" >&2; exit 1; }

source_date_epoch=${SOURCE_DATE_EPOCH:-}
if [ -z "$source_date_epoch" ]; then
    source_date_epoch=$(git log -1 --format=%ct HEAD)
fi
case "$source_date_epoch" in
    ''|*[!0-9]*) echo "SOURCE_DATE_EPOCH must be an unsigned integer" >&2; exit 2 ;;
esac
if [ "$(uname -s)" = Darwin ]; then
    normalized_timestamp=$(date -u -r "$source_date_epoch" +%Y%m%d%H%M.%S)
else
    normalized_timestamp=$(date -u -d "@$source_date_epoch" +%Y%m%d%H%M.%S)
fi
find "$package_root" -exec touch -t "$normalized_timestamp" {} +

file_list="$staging_root/archive-files.txt"
(cd "$staging_root" && find "$archive_base" -print | LC_ALL=C sort >"$file_list")
tar_archive="$output_directory/.$archive_base.tar.$$"
compressed_archive="$output_directory/.$archive_base.tar.gz.$$"
trap 'rm -rf "$staging_root"; rm -f "$tar_archive" "$compressed_archive"' EXIT HUP INT TERM
if tar --version 2>&1 | grep -Fq bsdtar; then
    tar -C "$staging_root" -cf "$tar_archive" \
        --format ustar --uid 0 --gid 0 --uname root --gname root \
        --no-recursion --no-xattrs -T "$file_list"
else
    tar -C "$staging_root" -cf "$tar_archive" \
        --format=ustar --owner=0 --group=0 --numeric-owner \
        --no-recursion --no-xattrs -T "$file_list"
fi
gzip -n -9 -c "$tar_archive" >"$compressed_archive"
mv "$compressed_archive" "$archive"
rm -f "$tar_archive"

if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$archive"
else
    shasum -a 256 "$archive"
fi
