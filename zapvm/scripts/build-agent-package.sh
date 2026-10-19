#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$repo_dir/packaging/guest/rootfs-lock.env"

target_arch=${1:-arm64}
agent_binary=${ZAPVM_AGENT_BINARY:-}
agent_root=${ZAPVM_AGENT_ROOT:-}
agent_id=${ZAPVM_AGENT_ID:-zapcode}
agent_version=${ZAPVM_AGENT_VERSION:-}
created_at=${ZAPVM_AGENT_CREATED_AT:-}
source_commit=${ZAPVM_AGENT_SOURCE_COMMIT:-}
build_target=${ZAPVM_AGENT_BUILD_TARGET:-}
builder_version=${ZAPVM_AGENT_BUILDER_VERSION:-}
private_key=${ZAPVM_AGENT_SIGNING_PRIVATE_KEY:-}
output_root=${ZAPVM_AGENT_OUTPUT_ROOT:-"$repo_dir/dist/agents"}
replace_output=${ZAPVM_REPLACE_OUTPUT:-0}

case "$target_arch" in
	arm64) docker_arch=arm64 ;;
	amd64) docker_arch=amd64 ;;
	*) echo "unsupported Agent architecture: $target_arch" >&2; exit 2 ;;
esac
if [ -n "$agent_root" ]; then
	case "$agent_root" in
		/*) ;;
		*) echo "ZAPVM_AGENT_ROOT must be an absolute directory" >&2; exit 2 ;;
	esac
	[ -d "$agent_root" ] && [ ! -L "$agent_root" ] && [ -x "$agent_root/bin/agent" ] && [ ! -L "$agent_root/bin/agent" ] || {
		echo "ZAPVM_AGENT_ROOT must contain a regular executable bin/agent" >&2
		exit 2
	}
	unsafe_path=$(find "$agent_root" \( -type l -o ! \( -type d -o -type f \) \) -print -quit)
	if [ -n "$unsafe_path" ]; then
		echo "ZAPVM_AGENT_ROOT contains a symlink or special file: $unsafe_path" >&2
		exit 2
	fi
	agent_entrypoint="$agent_root/bin/agent"
else
	case "$agent_binary" in
		/*) ;;
		*) echo "ZAPVM_AGENT_BINARY or ZAPVM_AGENT_ROOT must select an absolute Agent entrypoint" >&2; exit 2 ;;
	esac
	[ -f "$agent_binary" ] && [ ! -L "$agent_binary" ] || {
		echo "ZAPVM_AGENT_BINARY must be a regular non-symlink file" >&2
		exit 2
	}
	agent_entrypoint="$agent_binary"
fi
case "$agent_id" in
	""|*[!0-9A-Za-z._-]*) echo "ZAPVM_AGENT_ID is invalid" >&2; exit 2 ;;
esac
for token in "$agent_version" "$build_target" "$builder_version"; do
	case "$token" in
		""|*[!0-9A-Za-z._+-]*) echo "Agent version and provenance tokens are required" >&2; exit 2 ;;
	esac
done
printf '%s\n' "$source_commit" | grep -Eq '^[0-9a-f]{40}$' || {
	echo "ZAPVM_AGENT_SOURCE_COMMIT must be a lowercase 40-character Git commit" >&2
	exit 2
}
printf '%s\n' "$created_at" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || {
	echo "ZAPVM_AGENT_CREATED_AT must be an RFC3339 UTC second timestamp" >&2
	exit 2
}
if [ -z "$agent_root" ]; then
	case "$target_arch:$(file -b "$agent_binary")" in
		arm64:*ELF\ 64-bit*ARM\ aarch64*) ;;
		amd64:*ELF\ 64-bit*x86-64*) ;;
		*) echo "Agent binary architecture does not match $target_arch" >&2; exit 2 ;;
	esac
fi
case "$output_root" in
	/*) ;;
	*) output_root="$repo_dir/$output_root" ;;
esac
if [ -n "$private_key" ]; then
	case "$private_key" in
		/*) ;;
		*) echo "ZAPVM_AGENT_SIGNING_PRIVATE_KEY must be absolute" >&2; exit 2 ;;
	esac
	[ -f "$private_key" ] && [ ! -L "$private_key" ] || {
		echo "Agent signing private key must be a regular non-symlink file" >&2
		exit 2
	}
fi

destination="$output_root/$target_arch/$agent_id/$agent_version"
if [ -e "$destination" ] && [ "$replace_output" != 1 ]; then
	echo "destination already exists: $destination (set ZAPVM_REPLACE_OUTPUT=1 for recoverable replacement)" >&2
	exit 1
fi
mkdir -p "$(dirname "$destination")"
stage=$(mktemp -d "$(dirname "$destination")/.agent-package.XXXXXX")
committed=0
cleanup() {
	if [ "$committed" -eq 0 ]; then rm -rf "$stage"; fi
}
trap cleanup EXIT INT TERM

mkdir -p "$stage/agent-root/bin"
if [ -n "$agent_root" ]; then
	cp -R "$agent_root/." "$stage/agent-root/"
else
	install -m 0755 "$agent_binary" "$stage/agent-root/bin/agent"
fi
if command -v sha256sum >/dev/null 2>&1; then
	binary_sha256=$(sha256sum "$agent_entrypoint" | awk '{print $1}')
else
	binary_sha256=$(shasum -a 256 "$agent_entrypoint" | awk '{print $1}')
fi
printf '{"schema_version":1,"agent_version":"%s","source_commit":"%s","build_target":"%s","builder_version":"%s","binary_sha256":"%s"}\n' \
	"$agent_version" "$source_commit" "$build_target" "$builder_version" "$binary_sha256" \
	>"$stage/agent-provenance.json"

docker run --rm --platform "linux/$docker_arch" \
	-v "$stage:/output" "$ALPINE_BASE_IMAGE" /bin/sh -eu -c '
		apk add --no-cache e2fsprogs-extra qemu-img >/dev/null
		cp -a /output/agent-root /tmp/agent-root
		truncate -s 512M /output/agent.raw
		E2FSPROGS_FAKE_TIME=1785860000 mkfs.ext4 -q -F \
			-U 1dfef3da-2c05-44cf-8826-41da2f3e3a44 \
			-L zapvm-agent -d /tmp/agent-root /output/agent.raw
		qemu-img convert -f raw -O vhdx -o subformat=dynamic \
			/output/agent.raw /output/agent.vhdx
	'
rm -rf "$stage/agent-root"

tool="$stage/zapvm-image"
go build -trimpath -o "$tool" "$repo_dir/cmd/zapvm-image"
"$tool" agent-manifest \
	--id "$agent_id" --version "$agent_version" --arch "$target_arch" \
	--created-at "$created_at" --output "$stage/agent.json" \
	"$stage/agent.raw" "$stage/agent.vhdx" "$stage/agent-provenance.json"
if [ -n "$private_key" ]; then
	"$tool" agent-sign --manifest "$stage/agent.json" --private-key "$private_key" --output "$stage/agent.sig"
fi
rm -f "$tool"

if [ -e "$destination" ]; then
	backup="$destination.previous.$(date -u +%Y%m%dT%H%M%SZ)"
	mv "$destination" "$backup"
fi
mv "$stage" "$destination"
committed=1
printf '%s\n' "$destination"
