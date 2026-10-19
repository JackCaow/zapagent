#!/bin/sh
set -eu

dim_binary=${DIM_ACP_BINARY:-}
output=${DIM_AGENT_ROOT_OUTPUT:-}
glibc_root=${DIM_GLIBC_ROOT:-}
agent_version=${DIM_AGENT_VERSION:-}

case "$dim_binary" in
	/*) ;;
	*) echo "DIM_ACP_BINARY must be an absolute Linux Dim executable" >&2; exit 2 ;;
esac
[ -f "$dim_binary" ] && [ ! -L "$dim_binary" ] && [ -x "$dim_binary" ] || {
	echo "DIM_ACP_BINARY must be a regular executable" >&2
	exit 2
}
case "$agent_version" in
	""|*/*|*\\*) echo "DIM_AGENT_VERSION is required and must be a simple version" >&2; exit 2 ;;
esac
case "$glibc_root" in
	/*) ;;
	*) echo "DIM_GLIBC_ROOT must be an absolute minimal arm64 glibc directory" >&2; exit 2 ;;
esac
for library in ld-linux-aarch64.so.1 libc.so.6 libpthread.so.0 libdl.so.2 libm.so.6; do
	[ -f "$glibc_root/$library" ] && [ ! -L "$glibc_root/$library" ] || {
		echo "DIM_GLIBC_ROOT is missing regular file $library" >&2
		exit 2
	}
done
case "$output" in
	/*) ;;
	*) echo "DIM_AGENT_ROOT_OUTPUT must be an absolute new directory" >&2; exit 2 ;;
esac
[ ! -e "$output" ] || {
	echo "DIM_AGENT_ROOT_OUTPUT already exists: $output" >&2
	exit 1
}

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$output/bin" "$output/lib"
install -m 0755 "$dim_binary" "$output/bin/dim"
install -m 0755 "$repo_dir/packaging/agent/dim/agent" "$output/bin/agent"
printf '%s\n' "$agent_version" >"$output/version"
for library in ld-linux-aarch64.so.1 libc.so.6 libpthread.so.0 libdl.so.2 libm.so.6; do
	install -m 0755 "$glibc_root/$library" "$output/lib/$library"
done
printf '%s\n' "$output"
