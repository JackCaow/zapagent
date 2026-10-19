#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 <version>" >&2
    echo "example: $0 v0.2.0" >&2
    exit 2
fi

version=${1#v}
repository=${ZAPVM_GITHUB_REPOSITORY:-JackCaow/zapVM}
install_directory=${ZAPVM_INSTALL_DIRECTORY:-"$HOME/.local/bin"}
share_directory=${ZAPVM_SHARE_DIRECTORY:-"${install_directory%/*}/share/zapvm"}

case "$version" in
    ''|*[!0-9A-Za-z.+-]*) echo "invalid version: $version" >&2; exit 2 ;;
esac

host_os=$(uname -s)
case "$host_os" in
    Darwin) host_os=darwin ;;
    Linux) host_os=linux ;;
    *) echo "unsupported host OS: $host_os" >&2; exit 2 ;;
esac

host_arch=$(uname -m)
case "$host_arch" in
    x86_64|amd64) host_arch=amd64 ;;
    arm64|aarch64) host_arch=arm64 ;;
    *) echo "unsupported host architecture: $host_arch" >&2; exit 2 ;;
esac

archive_base="zapvm_${version}_${host_os}_${host_arch}"
archive="$archive_base.tar.gz"
base_url=${ZAPVM_RELEASE_BASE_URL:-"https://github.com/$repository/releases/download/v$version"}
case "$base_url" in
    https://*) ;;
    *) echo "ZAPVM_RELEASE_BASE_URL must use https" >&2; exit 2 ;;
esac
base_url=${base_url%/}
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$temporary_directory/$archive" "$base_url/$archive"
curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$temporary_directory/SHA256SUMS" "$base_url/SHA256SUMS"

expected=$(awk -v name="./$archive" '$2 == name { print $1 }' "$temporary_directory/SHA256SUMS")
if [ -z "$expected" ]; then
    expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$temporary_directory/SHA256SUMS")
fi
if [ -z "$expected" ]; then
    echo "release checksum does not contain $archive" >&2
    exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temporary_directory/$archive" | awk '{ print $1 }')
else
    actual=$(shasum -a 256 "$temporary_directory/$archive" | awk '{ print $1 }')
fi
if [ "$actual" != "$expected" ]; then
    echo "checksum mismatch for $archive" >&2
    exit 1
fi

tar -tzf "$temporary_directory/$archive" | awk '
    /^\// || /(^|\/)\.\.($|\/)/ { bad = 1 }
    END { exit bad }
' || { echo "release archive contains an unsafe path" >&2; exit 1; }
tar -C "$temporary_directory" -xzf "$temporary_directory/$archive"
package_root="$temporary_directory/$archive_base"
if find "$package_root" -type l -print | grep -q .; then
    echo "release archive contains a symlink" >&2
    exit 1
fi
for binary in zapvm zapvm-node zapvm-agent-adapter zapvm-image zapvm-sbom zapvm-host-install; do
    test -f "$package_root/$binary" && test ! -L "$package_root/$binary"
done
for example in daemon.json cloud-node.json cloud-node-managed.json; do
    test -f "$package_root/examples/$example" && test ! -L "$package_root/examples/$example"
done

if [ "$host_os" = darwin ]; then
    codesign --verify --strict "$package_root/zapvm"
    codesign --verify --strict "$package_root/zapvm-node"
    codesign --verify --strict "$package_root/zapvm-agent-adapter"
fi

mkdir -p "$install_directory"
for binary in zapvm zapvm-node zapvm-agent-adapter zapvm-image zapvm-sbom zapvm-host-install; do
    install -m 0755 "$package_root/$binary" "$install_directory/$binary"
done
mkdir -p "$share_directory/docs" "$share_directory/examples"
for document in installation.md host-install-macos.md host-install-linux.md host-install-windows.md node-operations.md agent-integration.md; do
    install -m 0644 "$package_root/docs/$document" "$share_directory/docs/$document"
done
for example in daemon.json cloud-node.json cloud-node-managed.json; do
    install -m 0644 "$package_root/examples/$example" "$share_directory/examples/$example"
done

echo "installed zapVM Host tools in $install_directory"
echo "run: $install_directory/zapvm doctor"
echo "remote Host installer: $install_directory/zapvm-host-install"
echo "offline guides and configuration examples: $share_directory"
echo "a separately signed guest image is required; see $share_directory/docs/installation.md"
