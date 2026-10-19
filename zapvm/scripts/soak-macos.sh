#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
iterations=${1:-10}
state_disk=${2:-"$repo_dir/.cache/soak/mac-state.raw"}
workspace=${3:-"$repo_dir/.cache/rw-workspace"}

case "$iterations" in
    *[!0-9]*|'')
        echo "iterations must be a positive integer" >&2
        exit 2
        ;;
esac
if [ "$iterations" -le 0 ]; then
    echo "iterations must be a positive integer" >&2
    exit 2
fi

mkdir -p "$(dirname -- "$state_disk")" "$workspace" "$repo_dir/.cache/soak"
signed_image_dir=$(mktemp -d "$repo_dir/.cache/soak/signed-image-XXXXXX")
image_root="$signed_image_dir/images"
image_private_key="$signed_image_dir/image-private.pem"
image_public_key="$signed_image_dir/image-public.pem"
image_signature="$signed_image_dir/manifest.sig"
image_tool="$repo_dir/bin/zapvm-image"

(cd "$repo_dir" && go build -trimpath -o "$image_tool" ./cmd/zapvm-image)
"$image_tool" keygen --private "$image_private_key" --public "$image_public_key"
"$image_tool" sign --manifest "$repo_dir/dist/arm64/manifest.json" --private-key "$image_private_key" --output "$image_signature"
rm -f "$image_private_key"
"$image_tool" install \
    --manifest "$repo_dir/dist/arm64/manifest.json" \
    --signature "$image_signature" \
    --public-key "$image_public_key" \
    --destination "$image_root/0.1.0-dev"
"$image_tool" activate --root "$image_root" --version 0.1.0-dev --public-key "$image_public_key"

if [ ! -f "$state_disk" ]; then
    "$repo_dir/bin/zapvm" state create \
        --template "$repo_dir/dist/arm64/state.raw" \
        --output "$state_disk" \
        --format raw \
        --schema 2
fi

iteration=1
while [ "$iteration" -le "$iterations" ]; do
    "$repo_dir/bin/zapvm" run \
        --id "mac-soak-$iteration" \
		--image-root "$image_root" \
		--image-public-key "$image_public_key" \
        --state-disk "$state_disk" \
        --workspace "$workspace" \
        --cmdline 'console=hvc0 root=/dev/vda ro rootfstype=ext4 modules=ext4,virtio_blk,virtiofs' \
        --network off \
        --console=false \
        --stop-after-exec \
        -- /bin/sh -c '
            set -eu
            expected=$1
            probe=/var/lib/zapvm/data/soak-count
            previous=0
            if [ -f "$probe" ]; then
                previous=$(cat "$probe")
            fi
            test "$previous" -eq "$((expected - 1))"
            printf "%s\n" "$expected" >"$probe"
            sync
            echo "SOAK_ITERATION_${expected}_OK"
        ' soak "$iteration"
    iteration=$((iteration + 1))
done

"$repo_dir/bin/zapvm" state inspect --disk "$state_disk"
