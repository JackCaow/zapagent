#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$repo_dir/packaging/linux/runtime-lock.env"
# shellcheck disable=SC1091
. "$repo_dir/packaging/guest/rootfs-lock.env"
target_arch=${1:-arm64}
image_version=${ZAPVM_IMAGE_VERSION:-0.1.0-dev}
output_root=${ZAPVM_OUTPUT_ROOT:-"$repo_dir/dist"}
replace_output=${ZAPVM_REPLACE_OUTPUT:-0}
image_profile=${ZAPVM_IMAGE_PROFILE:-host-runtime}
base_version=${ZAPVM_BASE_VERSION:-$ROOTFS_BASE_VERSION}
runtime_version=${ZAPVM_RUNTIME_VERSION:-$image_version}
session_version=${ZAPVM_SESSION_VERSION:-3}

case "$image_profile" in
	host-runtime) ;;
	*) echo "unsupported ZAPVM_IMAGE_PROFILE: $image_profile" >&2; exit 2 ;;
esac
[ -z "${ZAPVM_ZAP_BINARY:-}" ] || {
	echo "ZAPVM_ZAP_BINARY is no longer supported; build a signed ACP Agent package separately" >&2
	exit 2
}

case "$output_root" in
	/*) ;;
	*) output_root="$repo_dir/$output_root" ;;
esac
for layer_version in "$base_version" "$runtime_version" "$session_version"; do
	case "$layer_version" in
	""|.|..|*/*|*\\*)
		echo "invalid layer version: $layer_version" >&2
		exit 2
		;;
	esac
done
case "$image_version" in
	""|.|..|*/*|*\\*)
		echo "invalid image version: $image_version" >&2
		exit 2
		;;
esac

case "$target_arch" in
    arm64)
        docker_arch=arm64
		expected_apk_database_sha256=$APK_INSTALLED_ARM64_SHA256
		expected_apk_packages=$APK_INSTALLED_ARM64_PACKAGES
        ;;
    amd64)
        docker_arch=amd64
		expected_apk_database_sha256=$APK_INSTALLED_AMD64_SHA256
		expected_apk_packages=$APK_INSTALLED_AMD64_PACKAGES
        ;;
    *)
        echo "unsupported architecture: $target_arch" >&2
        exit 2
        ;;
esac

build_dir="$repo_dir/.build/image-context-$target_arch"
# Validate reviewed inputs before compiling tools or accessing package mirrors.
sh "$repo_dir/scripts/install-rootfs-packages.sh" "$repo_dir/packaging/guest" "$target_arch" --verify-only
destination_dir="$output_root/$target_arch"
container_name="zapvm-rootfs-$target_arch-$$"
image_name="zapvm-rootfs:$target_arch-dev"

if [ -e "$destination_dir" ] && [ "$replace_output" != 1 ]; then
	echo "destination already exists: $destination_dir (set ZAPVM_REPLACE_OUTPUT=1 for recoverable replacement)" >&2
	exit 1
fi
mkdir -p "$build_dir" "$output_root"
output_dir=$(mktemp -d "$output_root/.image-$target_arch.XXXXXX")
committed=0

cleanup() {
	docker rm -f "$container_name" >/dev/null 2>&1 || true
	if [ "$committed" -eq 0 ]; then
		rm -rf "$output_dir"
	fi
}
trap cleanup EXIT INT TERM

GOOS=linux GOARCH="$target_arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' \
    -o "$build_dir/zapvm-agent" "$repo_dir/cmd/zapvm-agent"
GOOS=linux GOARCH="$target_arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' \
    -o "$build_dir/zapvm-launcher" "$repo_dir/cmd/zapvm-launcher"
GOOS=linux GOARCH="$target_arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' \
    -o "$build_dir/zapvm-proxy-bridge" "$repo_dir/cmd/zapvm-proxy-bridge"
GOOS=linux GOARCH="$target_arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' \
    -o "$build_dir/zapvm-plan9-mount" "$repo_dir/cmd/zapvm-plan9-mount"
GOOS=linux GOARCH="$target_arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' \
    -o "$build_dir/zapvm-resident-agent" "$repo_dir/cmd/zapvm-resident-agent"
go build -trimpath -o "$build_dir/zapvm-image" "$repo_dir/cmd/zapvm-image"
go build -trimpath -o "$build_dir/zapvm-sbom" "$repo_dir/cmd/zapvm-sbom"

resident_agent_available=false
install -m 0755 "$repo_dir/packaging/guest/zap-unavailable" "$build_dir/zap"

docker build \
    --platform "linux/$docker_arch" \
	--build-arg "ZAPVM_ALPINE_BASE_IMAGE=$ALPINE_BASE_IMAGE" \
	--build-arg "ZAPVM_CONTEXT_ARCH=$target_arch" \
	--build-arg "ZAPVM_IMAGE_PROFILE=$image_profile" \
	--build-arg "ZAPVM_RESIDENT_AGENT_AVAILABLE=$resident_agent_available" \
	--build-arg "ZAPVM_ZAP_VERSION=unavailable" \
    -f "$repo_dir/images/Dockerfile.rootfs" \
    -t "$image_name" \
    "$repo_dir"

docker create --platform "linux/$docker_arch" --name "$container_name" "$image_name" >/dev/null
docker cp "$container_name:/boot/vmlinuz-virt" "$output_dir/vmlinuz"
docker cp "$container_name:/boot/initramfs-virt" "$output_dir/initramfs"
docker cp "$container_name:/etc/zapvm/capabilities.json" "$output_dir/capabilities.json"
apk_database="$build_dir/apk-installed-$target_arch"
docker cp "$container_name:/lib/apk/db/installed" "$apk_database"
actual_apk_database_sha256=$(shasum -a 256 "$apk_database" | awk '{print $1}')
actual_apk_packages=$(grep -c '^P:' "$apk_database")
if [ "$actual_apk_database_sha256" != "$expected_apk_database_sha256" ] || [ "$actual_apk_packages" != "$expected_apk_packages" ]; then
	echo "Alpine package closure drift for $target_arch: sha256=$actual_apk_database_sha256 packages=$actual_apk_packages" >&2
	echo "expected sha256=$expected_apk_database_sha256 packages=$expected_apk_packages; review and bump the Base lock/version" >&2
	exit 1
fi
echo "verified immutable Alpine package closure for $target_arch: sha256=$actual_apk_database_sha256 packages=$actual_apk_packages"
docker export -o "$output_dir/rootfs.tar" "$container_name"
zapvm_source_commit=$(git -C "$repo_dir" rev-parse HEAD)

"$build_dir/zapvm-sbom" \
	--installed "$apk_database" \
	--arch "$target_arch" \
	--version "$image_version" \
	--created 2026-08-05T00:00:00Z \
	--zapvm-source-commit "$zapvm_source_commit" \
	--cloud-hypervisor-version "$CLOUD_HYPERVISOR_VERSION" \
	--cloud-hypervisor-source-url "$CLOUD_HYPERVISOR_SOURCE_URL" \
	--cloud-hypervisor-source-sha256 "$CLOUD_HYPERVISOR_SOURCE_SHA256" \
	--virtiofsd-version "$VIRTIOFSD_VERSION" \
	--virtiofsd-source-url "$VIRTIOFSD_SOURCE_URL" \
	--virtiofsd-source-sha256 "$VIRTIOFSD_SOURCE_SHA256" \
	--virtiofsd-source-commit "$VIRTIOFSD_COMMIT" \
	--image-profile "$image_profile" \
	--zap-version unavailable \
	--zap-source-commit unavailable \
	--source-offer-output "$output_dir/source-offer.json" \
	--output "$output_dir/sbom.spdx.json"
rm -f "$apk_database"

ZAPVM_ARCH_OUTPUT_DIR="$output_dir" "$repo_dir/scripts/build-linux-runtime.sh" "$target_arch"

"$build_dir/zapvm-image" extract-kernel \
    --arch "$target_arch" \
    --input "$output_dir/vmlinuz" \
    --output "$output_dir/kernel"

docker run --rm --privileged \
    --platform "linux/$docker_arch" \
	-e "ZAPVM_IMAGE_PROFILE=$image_profile" \
	-e "ZAPVM_CONVERTER_ARCH=$target_arch" \
	-v "$repo_dir/packaging/linux:/zapvm-converter-lock:ro" \
	-v "$repo_dir/scripts/install-image-converter-packages.sh:/zapvm-install-converter-packages:ro" \
	-v "$output_dir:/output" \
    "$ALPINE_BASE_IMAGE" \
    sh -euxc '
        sh /zapvm-install-converter-packages /zapvm-converter-lock "$ZAPVM_CONVERTER_ARCH"
        rm -rf /tmp/rootfs
        mkdir -p /tmp/rootfs
        tar -xf /output/rootfs.tar -C /tmp/rootfs
        rm -f /output/rootfs.tar
        truncate -s 1536M /output/rootfs.raw
		E2FSPROGS_FAKE_TIME=1785860000 mkfs.ext4 -q -F \
			-U 8d5e2400-659b-4fd6-9ca5-7c3020c2b815 \
			-L zapvm-root -d /tmp/rootfs /output/rootfs.raw
		qemu-img convert -f raw -O vhdx -o subformat=dynamic \
			/output/rootfs.raw /output/rootfs.vhdx
		rm -rf /tmp/state-root
		mkdir -p /tmp/state-root/data /tmp/state-root/sessions /tmp/state-root/computer/nix /tmp/state-root/.schema-migrations
		printf "3\n" >/tmp/state-root/schema-version
		printf "2\n" >/tmp/state-root/.schema-migrations/2
		printf "3\n" >/tmp/state-root/.schema-migrations/3
		chmod 0755 /tmp/state-root /tmp/state-root/data
		chmod 0711 /tmp/state-root/sessions
		chmod 0711 /tmp/state-root/computer
		chown 501:20 /tmp/state-root/computer/nix
		chmod 0700 /tmp/state-root/computer/nix
		chmod 0700 /tmp/state-root/.schema-migrations
		truncate -s 512M /output/state.raw
		E2FSPROGS_FAKE_TIME=1785860000 mkfs.ext4 -q -F \
			-U 4efcd231-418b-4e37-a750-a8bd690a5d41 \
			-L zapvm-state -d /tmp/state-root /output/state.raw
		qemu-img create -f vhdx -o subformat=dynamic /output/state.vhdx 16G
		qemu-img convert -n -f raw -O vhdx \
			/output/state.raw /output/state.vhdx
		qemu-img info --output=json /output/state.vhdx | tr -d "[:space:]" | grep -F "\"virtual-size\":17179869184"
	'

"$build_dir/zapvm-image" manifest \
	--profile host-runtime --arch "$target_arch" --version "$image_version" \
	--base-version "$base_version" --runtime-version "$runtime_version" \
	--session-version "$session_version" --output "$output_dir/manifest.json" \
	"$output_dir/kernel" "$output_dir/initramfs" \
	"$output_dir/rootfs.raw" "$output_dir/rootfs.vhdx" \
	"$output_dir/state.raw" "$output_dir/state.vhdx" \
	"$output_dir/cloud-hypervisor" "$output_dir/virtiofsd" \
	"$output_dir/linux-runtime-provenance.json" "$output_dir/capabilities.json" \
	"$output_dir/sbom.spdx.json" "$output_dir/source-offer.json"

if [ -e "$destination_dir" ]; then
	if [ "$replace_output" != 1 ]; then
		echo "destination already exists: $destination_dir (set ZAPVM_REPLACE_OUTPUT=1 for recoverable replacement)" >&2
		exit 1
	fi
	backup_dir="$output_root/.previous-$target_arch-$(date +%Y%m%d%H%M%S)-$$"
	mv "$destination_dir" "$backup_dir"
	echo "previous image retained at $backup_dir"
fi
mv "$output_dir" "$destination_dir"
output_dir="$destination_dir"
committed=1
echo "built image $image_version for $target_arch at $destination_dir"
