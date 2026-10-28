#!/bin/sh
set -eu
lock_dir=${1:?usage: verify-linux-builder-metadata.sh LOCK_DIRECTORY METADATA_DIRECTORY}
metadata_dir=${2:?usage: verify-linux-builder-metadata.sh LOCK_DIRECTORY METADATA_DIRECTORY}
# shellcheck disable=SC1091
. "$lock_dir/runtime-lock.env"
for metadata in rust-toolchain.txt builder-packages.txt; do
    [ -s "$metadata_dir/$metadata" ] && [ ! -L "$metadata_dir/$metadata" ] || {
        echo "locked runtime metadata is missing or unsafe: $metadata" >&2
        exit 1
    }
done
printf '%s  %s\n' "$RUST_BUILDER_TOOLCHAIN_SHA256" "$metadata_dir/rust-toolchain.txt" | shasum -a 256 -c -
printf '%s  %s\n' "$RUST_BUILDER_PACKAGES_METADATA_SHA256" "$metadata_dir/builder-packages.txt" | shasum -a 256 -c -
