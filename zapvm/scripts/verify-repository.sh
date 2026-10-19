#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

required_files='LICENSE NOTICE THIRD_PARTY_NOTICES.md CONTRIBUTING.md SECURITY.md SUPPORT.md GOVERNANCE.md CODE_OF_CONDUCT.md CHANGELOG.md docs/threat-model.md docs/support-matrix.md docs/compatibility.md docs/release.md docs/error-taxonomy.md'
for required_file in $required_files; do
    if [ ! -s "$required_file" ]; then
        echo "required repository file is missing or empty: $required_file" >&2
        exit 1
    fi
done
if ! grep -Eq '^ALPINE_BASE_IMAGE=alpine:3\.23\.5@sha256:[0-9a-f]{64}$' packaging/guest/rootfs-lock.env; then
    echo "rootfs lock is missing the immutable Alpine image digest" >&2
    exit 1
fi
if ! grep -Eq '^ROOTFS_BASE_VERSION=alpine-3\.23\.5-r[1-9][0-9]*$' packaging/guest/rootfs-lock.env ||
   ! grep -Fq 'base_version=${ZAPVM_BASE_VERSION:-$ROOTFS_BASE_VERSION}' scripts/build-rootfs.sh; then
    echo "rootfs package lock and Base version are not bound" >&2
    exit 1
fi
for arch in AMD64 ARM64; do
    if ! grep -Eq "^APK_INSTALLED_${arch}_SHA256=[0-9a-f]{64}$" packaging/guest/rootfs-lock.env ||
       ! grep -Eq "^APK_INSTALLED_${arch}_PACKAGES=[1-9][0-9]*$" packaging/guest/rootfs-lock.env; then
        echo "rootfs lock is missing the exact $arch APK closure" >&2
        exit 1
    fi
done
for rootfs_lock_marker in \
    'ZAPVM_ALPINE_BASE_IMAGE=$ALPINE_BASE_IMAGE' \
    'actual_apk_database_sha256' \
    'Alpine package closure drift'
do
    if ! grep -Fq -- "$rootfs_lock_marker" scripts/build-rootfs.sh; then
        echo "image builder is missing immutable Base marker: $rootfs_lock_marker" >&2
        exit 1
    fi
done
for arch in arm64 amd64; do
    sh scripts/install-rootfs-packages.sh packaging/guest "$arch" --verify-only
done

for required_layer_update_contract in \
    'case "target-metadata"' \
    'case "tuf-repository"' \
    'case "bundle-layers"' \
    'schema 3 image requires TUF target custom metadata schema 2' \
    'TUF target custom metadata schema 3 requires layer targets' \
    'signed layer version vector does not match TUF target metadata'
do
    if ! grep -Fq "$required_layer_update_contract" cmd/zapvm-image/main.go cmd/zapvm-image/update.go; then
        echo "layered update contract is missing marker: $required_layer_update_contract" >&2
        exit 1
    fi
done

for required_tuf_publisher_contract in \
    'TUF roles %s and %s must use different keys' \
    'stable publication requires separated production roles' \
    'TUF expiries must satisfy timestamp < snapshot < targets < root' \
    'publishNewDirectory' \
    'verifyPublicationPayload'
do
    if ! grep -Fq "$required_tuf_publisher_contract" cmd/zapvm-image/tuf_repository.go; then
        echo "TUF repository publisher is missing gate: $required_tuf_publisher_contract" >&2
        exit 1
    fi
done
if ! grep -Fq 'same version is equivocation and is' docs/layered-image-delivery.md; then
    echo "layered delivery documentation is missing the per-repository TUF key-domain rule" >&2
    exit 1
fi

for required_tls_update_contract in \
    'tls-ca' \
    'AppendCertsFromPEM' \
    'TLS CA bundle contains no certificates'
do
    if ! grep -Fq "$required_tls_update_contract" cmd/zapvm-image/update.go; then
        echo "private HTTPS update contract is missing marker: $required_tls_update_contract" >&2
        exit 1
    fi
done
if grep -Fq 'InsecureSkipVerify' cmd/zapvm-image/update.go; then
    echo "image updater must not disable TLS certificate or hostname verification" >&2
    exit 1
fi

if ! grep -Fq 'rm -f /output/rootfs.tar' scripts/build-rootfs.sh; then
    echo "image builder must remove the unsigned rootfs export after extraction" >&2
    exit 1
fi
for deterministic_host_marker in \
    'SOURCE_DATE_EPOCH' \
    'gzip -n -9' \
    '--no-recursion'
do
    if ! grep -Fq -- "$deterministic_host_marker" scripts/package-host-release.sh; then
        echo "Unix Host package is missing reproducibility marker: $deterministic_host_marker" >&2
        exit 1
    fi
done
for deterministic_windows_host_marker in \
    'SOURCE_DATE_EPOCH' \
    'ZipArchiveMode]::Create' \
    'LastWriteTime = $entryTimestamp' \
    'Sort-Object FullName'
do
    if ! grep -Fq -- "$deterministic_windows_host_marker" scripts/package-host-release.ps1; then
        echo "Windows Host package is missing reproducibility marker: $deterministic_windows_host_marker" >&2
        exit 1
    fi
done
if grep -Fq 'Compress-Archive -Path $PackageRoot' scripts/package-host-release.ps1; then
    echo "Windows Host package must use the deterministic ZIP writer" >&2
    exit 1
fi
for release_reproducibility_marker in \
    'release-rebuild' \
    'HOST_PACKAGE_REPRODUCIBLE'
do
    if ! grep -Fq -- "$release_reproducibility_marker" .github/workflows/release.yml; then
        echo "release workflow is missing Host reproducibility gate: $release_reproducibility_marker" >&2
        exit 1
    fi
done
if grep -Fq 'go run "$repo_dir/cmd/zapvm-image"' scripts/build-rootfs.sh ||
   grep -Fq 'go run "$repo_dir/cmd/zapvm-sbom"' scripts/build-rootfs.sh; then
    echo "image builder must reuse prebuilt Host tools instead of peak-space go run builds" >&2
    exit 1
fi
for required_runtime_lock in VIRTIOFSD_AMD64_SHA256 VIRTIOFSD_ARM64_SHA256 CLOUD_HYPERVISOR_SOURCE_SHA256 VIRTIOFSD_SOURCE_SHA256; do
    if ! grep -Eq "^${required_runtime_lock}=[0-9a-f]{64}$" packaging/linux/runtime-lock.env; then
        echo "Linux runtime lock is missing $required_runtime_lock" >&2
        exit 1
    fi
done
for source_offer_marker in \
    '--source-offer-output "$output_dir/source-offer.json"' \
    '--zapvm-source-commit "$zapvm_source_commit"' \
    '"$output_dir/source-offer.json"'
do
    if ! grep -Fq -- "$source_offer_marker" scripts/build-rootfs.sh; then
        echo "image builder is missing signed source-offer marker: $source_offer_marker" >&2
        exit 1
    fi
done
if ! grep -Fq 'ValidateSupplyChainMetadata(baseDirectory, manifest)' internal/image/manifest.go; then
    echo "image activation must validate signed SPDX/source-offer content" >&2
    exit 1
fi

for required_error_contract in \
    'ZAPVM_ERROR[%s]' \
    'ExitInvalidRequest' \
    'ExitInvalidConfiguration' \
    'ExitPermissionDenied'
do
    if ! grep -Fq "$required_error_contract" internal/clierror/clierror.go; then
        echo "stable CLI error contract is missing marker: $required_error_contract" >&2
        exit 1
    fi
done

release_workflow=.github/workflows/release.yml
for required_release_gate in \
    'release tag must be annotated and signed' \
    '.verification.verified == true' \
    '.verification.reason == "valid"' \
    '.merge_base_commit.sha == $commit' \
    'persist-credentials: false'
do
    if ! grep -Fq "$required_release_gate" "$release_workflow"; then
        echo "release workflow is missing authorization gate: $required_release_gate" >&2
        exit 1
    fi
done

native_candidate_workflow=.github/workflows/native-candidate-acceptance.yml
for required_native_candidate_gate in \
    'RUN_NATIVE_CANDIDATE_ACCEPTANCE' \
    'acceptance-native-candidate-linux.sh' \
    'acceptance-native-candidate-windows.ps1'
do
    if ! grep -Fq "$required_native_candidate_gate" "$native_candidate_workflow"; then
        echo "native candidate workflow is missing gate: $required_native_candidate_gate" >&2
        exit 1
    fi
done
for required_native_candidate_script_gate in \
    'preflight-self-hosted-unix.sh" linux-multi' \
    'ZAPVM_ACCEPTANCE_ZAPVM=' \
    'preflight-self-hosted-windows.ps1") -Target windows-acl-recovery' \
    'acceptance-windows-hcs-grant-recovery.ps1'
do
    if ! grep -Fq "$required_native_candidate_script_gate" \
        scripts/acceptance-native-candidate-linux.sh \
        scripts/acceptance-native-candidate-windows.ps1; then
        echo "native candidate entrypoint is missing gate: $required_native_candidate_script_gate" >&2
        exit 1
    fi
done
if grep -Eq 'runs-on:[[:space:]]*(ubuntu|windows|macos)-' "$native_candidate_workflow"; then
    echo "native candidate workflow must not depend on GitHub-hosted runners" >&2
    exit 1
fi

unformatted=$(git ls-files -z '*.go' | xargs -0 gofmt -l)
if [ -n "$unformatted" ]; then
    echo "Go files require gofmt:" >&2
    printf '%s\n' "$unformatted" >&2
    exit 1
fi

if ! go mod tidy -diff; then
    echo "go.mod or go.sum is not tidy" >&2
    exit 1
fi

if git grep -n \
    -e 'PRIVATE KEY-----' \
    -e 'github_pat_' \
    -e 'ghp_' \
    -e 'gho_' \
    -e 'ghu_' \
    -e 'ghr_' \
    -- . ':(exclude)scripts/verify-repository.sh'; then
    echo "possible committed credential or private key marker detected" >&2
    exit 1
fi

# GitHub App installation-token fixtures intentionally exercise the `ghs_`
# prefix. Keep production code and non-test assets fail-closed while allowing
# those explicit test vectors.
if git grep -n \
    -e 'ghs_' \
    -- . ':(exclude)scripts/verify-repository.sh' ':(exclude,glob)**/*_test.go'; then
    echo "possible committed GitHub installation token detected outside tests" >&2
    exit 1
fi

echo REPOSITORY_BASELINE_OK
