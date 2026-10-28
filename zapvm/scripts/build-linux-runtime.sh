#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_arch=${1:-arm64}

# shellcheck disable=SC1091
. "$repo_dir/packaging/linux/runtime-lock.env"

case "$target_arch" in
    amd64)
        cloud_hypervisor_url=$CLOUD_HYPERVISOR_AMD64_URL
        cloud_hypervisor_sha256=$CLOUD_HYPERVISOR_AMD64_SHA256
		rust_target=x86_64-unknown-linux-musl
		rust_builder_image=$RUST_BUILDER_AMD64_IMAGE
		virtiofsd_expected_sha256=$VIRTIOFSD_AMD64_SHA256
        ;;
    arm64)
        cloud_hypervisor_url=$CLOUD_HYPERVISOR_ARM64_URL
        cloud_hypervisor_sha256=$CLOUD_HYPERVISOR_ARM64_SHA256
		rust_target=aarch64-unknown-linux-musl
		rust_builder_image=$RUST_BUILDER_ARM64_IMAGE
		virtiofsd_expected_sha256=$VIRTIOFSD_ARM64_SHA256
        ;;
    *)
        echo "unsupported architecture: $target_arch" >&2
        exit 2
        ;;
esac

output_dir=${ZAPVM_ARCH_OUTPUT_DIR:-"$repo_dir/dist/$target_arch"}
build_dir="$repo_dir/.build/linux-runtime-$target_arch"
mkdir -p "$output_dir" "$build_dir"

cloud_hypervisor_part="$build_dir/cloud-hypervisor.part"
virtiofsd_part="$build_dir/virtiofsd.part"
provenance_part="$build_dir/linux-runtime-provenance.json.part"

cleanup() {
    rm -f "$cloud_hypervisor_part" "$virtiofsd_part" "$provenance_part"
}
trap cleanup EXIT INT TERM

curl --fail --location --silent --show-error \
    --proto '=https' --tlsv1.2 \
    "$cloud_hypervisor_url" -o "$cloud_hypervisor_part"
printf '%s  %s\n' "$cloud_hypervisor_sha256" "$cloud_hypervisor_part" | shasum -a 256 -c -
chmod 0755 "$cloud_hypervisor_part"

if [ "${ZAPVM_USE_RUNTIME_CACHE:-0}" = 1 ]; then
	cached_binary="$build_dir/cargo-target/$rust_target/release/virtiofsd"
	if [ ! -f "$cached_binary" ] || [ -L "$cached_binary" ]; then
		echo "locked virtiofsd cache is missing or unsafe: $cached_binary" >&2
		exit 1
	fi
	case "$target_arch:$(file -b "$cached_binary")" in
		amd64:*ELF\ 64-bit*x86-64*statically\ linked*|amd64:*ELF\ 64-bit*x86-64*static-pie\ linked*) ;;
		arm64:*ELF\ 64-bit*ARM\ aarch64*statically\ linked*|arm64:*ELF\ 64-bit*ARM\ aarch64*static-pie\ linked*) ;;
		*) echo "cached virtiofsd architecture or linkage is invalid" >&2; exit 1 ;;
	esac
	for metadata in rust-toolchain.txt builder-packages.txt; do
		[ -s "$build_dir/$metadata" ] && [ ! -L "$build_dir/$metadata" ] || {
			echo "locked runtime cache is missing $metadata" >&2
			exit 1
		}
	done
	install -m 0755 "$cached_binary" "$virtiofsd_part"
else
	docker run --rm \
		--platform "linux/$target_arch" \
		-e VIRTIOFSD_SOURCE_URL="$VIRTIOFSD_SOURCE_URL" \
		-e VIRTIOFSD_SOURCE_SHA256="$VIRTIOFSD_SOURCE_SHA256" \
		-e VIRTIOFSD_VERSION="$VIRTIOFSD_VERSION" \
		-e RUST_TARGET="$rust_target" \
		-e SOURCE_DATE_EPOCH=1785860000 \
		-e ZAPVM_BUILDER_ARCH="$target_arch" \
		-e CARGO_HOME=/work/cargo-home \
		-e CARGO_TARGET_DIR=/work/cargo-target \
		-v "$repo_dir/packaging/linux:/zapvm-build-lock:ro" \
		-v "$repo_dir/scripts/install-linux-builder-packages.sh:/zapvm-install-builder-packages:ro" \
		-v "$build_dir:/work" \
		"$rust_builder_image" \
		sh -euxc '
		sh /zapvm-install-builder-packages /zapvm-build-lock "$ZAPVM_BUILDER_ARCH"
		rm -rf /work/virtiofsd-source
        curl --fail --location --silent --show-error \
            --proto "=https" --tlsv1.2 \
            "$VIRTIOFSD_SOURCE_URL" -o /work/virtiofsd-source.tar.gz
        printf "%s  %s\n" "$VIRTIOFSD_SOURCE_SHA256" /work/virtiofsd-source.tar.gz | sha256sum -c -
        mkdir /work/virtiofsd-source
        tar -xzf /work/virtiofsd-source.tar.gz --strip-components=1 -C /work/virtiofsd-source
        cd /work/virtiofsd-source
		CARGO_INCREMENTAL=0 \
		RUSTFLAGS="-C target-feature=+crt-static -C link-self-contained=yes -C link-arg=-Wl,--build-id=none" \
		LIBSECCOMP_LINK_TYPE=static LIBSECCOMP_LIB_PATH=/usr/lib \
		LIBCAPNG_LINK_TYPE=static LIBCAPNG_LIB_PATH=/usr/lib \
			cargo build --locked --release --target "$RUST_TARGET"
		binary="$CARGO_TARGET_DIR/$RUST_TARGET/release/virtiofsd"
		"$binary" --version | grep -F "${VIRTIOFSD_VERSION#v}"
		file "$binary" | grep -E "statically linked|static-pie linked"
		install -m 0755 "$binary" /work/virtiofsd.part
        rustc --version >/work/rust-toolchain.txt
        cargo --version >>/work/rust-toolchain.txt
		apk info -v | grep -E "^(ca-certificates|curl|file|libcap-ng-static|libseccomp-static|musl-dev|pkgconf)-[0-9]" \
			| sort >/work/builder-packages.txt
    '
fi

# Provenance is part of the cache contract: a verified binary cannot be
# paired with arbitrary or stale builder metadata. Apply the same checks to
# fresh builds and cache restores before producing a provenance document.
sh "$repo_dir/scripts/verify-linux-builder-metadata.sh" "$repo_dir/packaging/linux" "$build_dir"
printf '%s  %s\n' "$virtiofsd_expected_sha256" "$virtiofsd_part" | shasum -a 256 -c -

virtiofsd_sha256=$(shasum -a 256 "$virtiofsd_part" | awk '{print $1}')
rust_toolchain=$(tr '\n' ';' <"$build_dir/rust-toolchain.txt" | sed 's/;$//')
builder_packages=$(tr '\n' ';' <"$build_dir/builder-packages.txt" | sed 's/;$//')

printf '%s\n' \
    '{' \
    '  "schema_version": 1,' \
    "  \"architecture\": \"$target_arch\"," \
    "  \"cloud_hypervisor_version\": \"$CLOUD_HYPERVISOR_VERSION\"," \
    "  \"cloud_hypervisor_sha256\": \"$cloud_hypervisor_sha256\"," \
    "  \"virtiofsd_version\": \"$VIRTIOFSD_VERSION\"," \
    "  \"virtiofsd_commit\": \"$VIRTIOFSD_COMMIT\"," \
    "  \"virtiofsd_source_sha256\": \"$VIRTIOFSD_SOURCE_SHA256\"," \
    "  \"virtiofsd_binary_sha256\": \"$virtiofsd_sha256\"," \
    "  \"builder_image\": \"$rust_builder_image\"," \
    "  \"rust_toolchain\": \"$rust_toolchain\"," \
    "  \"builder_packages\": \"$builder_packages\"" \
    '}' >"$provenance_part"

install -m 0755 "$cloud_hypervisor_part" "$output_dir/cloud-hypervisor"
install -m 0755 "$virtiofsd_part" "$output_dir/virtiofsd"
install -m 0644 "$provenance_part" "$output_dir/linux-runtime-provenance.json"

echo "built locked Linux runtime for $target_arch"
