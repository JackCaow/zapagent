#!/bin/sh
set -eu

umask 077

die() {
    printf '%s\n' "release-macos-host: $*" >&2
    exit 1
}

usage() {
    cat >&2 <<'EOF'
usage: release-macos-host.sh \
  --source-dir DIR --output-dir DIR --version VERSION \
  --signing-identity IDENTITY --keychain-profile PROFILE \
  [--source-commit SHA]

Signs every Mach-O executable in a macOS Host tools release, enables the
hardened runtime, submits a ZIP to Apple's notary service, verifies the ticket
CDHashes, and creates the Homebrew tarball plus release evidence files.
EOF
    exit 2
}

source_dir=
output_dir=
version=
signing_identity=
keychain_profile=
source_commit=

while [ "$#" -gt 0 ]; do
    case "$1" in
        --source-dir) source_dir=${2:-}; shift 2 ;;
        --output-dir) output_dir=${2:-}; shift 2 ;;
        --version) version=${2:-}; shift 2 ;;
        --signing-identity) signing_identity=${2:-}; shift 2 ;;
        --keychain-profile) keychain_profile=${2:-}; shift 2 ;;
        --source-commit) source_commit=${2:-}; shift 2 ;;
        *) usage ;;
    esac
done

[ -n "$source_dir" ] || usage
[ -n "$output_dir" ] || usage
[ -n "$version" ] || usage
[ -n "$signing_identity" ] || usage
[ -n "$keychain_profile" ] || usage

case "$version" in
    *[!A-Za-z0-9._+-]*|'') die "version contains unsafe characters" ;;
esac

command -v codesign >/dev/null || die "codesign is required"
command -v xcrun >/dev/null || die "xcrun is required"
command -v jq >/dev/null || die "jq is required"

source_dir=$(cd "$source_dir" && pwd -P)
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd -P)
package_name="zapvm_${version}_darwin_arm64"
stage="$output_dir/$package_name"
[ ! -e "$stage" ] || die "output staging path already exists: $stage"
mkdir -m 700 "$stage"
cp -R "$source_dir"/. "$stage"/

entitlements=$(cd "$(dirname "$0")/.." && pwd -P)/packaging/macos/zapvm.entitlements
[ -f "$entitlements" ] || die "missing entitlement file: $entitlements"

for required in zapvm zapvm-node zapvm-sbom zapvm-image; do
    [ -f "$stage/$required" ] && [ -x "$stage/$required" ] ||
        die "missing executable: $required"
done

for executable in zapvm-sbom zapvm-image zapvm-node; do
    codesign --force --sign "$signing_identity" --timestamp --options runtime "$stage/$executable"
done
codesign --force --sign "$signing_identity" --timestamp --options runtime \
    --entitlements "$entitlements" "$stage/zapvm"

for executable in zapvm zapvm-node zapvm-sbom zapvm-image; do
    codesign --verify --strict --verbose=2 "$stage/$executable"
    codesign -dvv "$stage/$executable" 2>&1 | grep -q 'flags=.*runtime' ||
        die "$executable does not have the hardened runtime"
    codesign -dvv "$stage/$executable" 2>&1 | grep -q '^Timestamp=' ||
        die "$executable does not have a secure timestamp"
done
codesign -d --entitlements :- "$stage/zapvm" 2>/dev/null |
    grep -q 'com.apple.security.virtualization' ||
    die "zapvm lost its virtualization entitlement"

zip_path="$output_dir/$package_name.zip"
(cd "$output_dir" && /usr/bin/ditto -c -k --keepParent "$package_name" "$package_name.zip")
submission_json="$output_dir/NOTARIZATION-SUBMISSION.json"
xcrun notarytool submit "$zip_path" --keychain-profile "$keychain_profile" \
    --wait --output-format json >"$submission_json"
status=$(jq -r '.status // empty' "$submission_json")
[ "$status" = Accepted ] || die "notarization status is ${status:-unknown}"
submission_id=$(jq -r '.id' "$submission_json")
notary_log="$output_dir/NOTARIZATION-LOG.json"
xcrun notarytool log "$submission_id" --keychain-profile "$keychain_profile" "$notary_log" >/dev/null
[ "$(jq -r '.status' "$notary_log")" = Accepted ] || die "notary log is not Accepted"

for executable in zapvm zapvm-node zapvm-sbom zapvm-image; do
    actual=$(codesign -dv --verbose=4 "$stage/$executable" 2>&1 |
        awk -F= '/^CDHash=/{print $2}')
    expected=$(jq -r --arg suffix "/$executable" \
        '.ticketContents[] | select(.path | endswith($suffix)) | .cdhash' "$notary_log")
    [ -n "$expected" ] && [ "$actual" = "$expected" ] ||
        die "notary ticket CDHash mismatch for $executable"
done

tar_path="$output_dir/$package_name.tar.gz"
(cd "$output_dir" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$package_name.tar.gz" "$package_name")
sha256=$(/usr/bin/shasum -a 256 "$tar_path" | awk '{print $1}')
size=$(/usr/bin/stat -f '%z' "$tar_path")
team_identifier=$(codesign -dvv "$stage/zapvm" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2}')

printf '%s  %s\n' "$sha256" "$package_name.tar.gz" >"$output_dir/SHA256SUMS"
cat >"$output_dir/BUILD-IDENTITY.txt" <<EOF
SOURCE_COMMIT=$source_commit
VERSION=$version
SIGNING_IDENTITY=$signing_identity
TEAM_IDENTIFIER=$team_identifier
NOTARIZATION_SUBMISSION_ID=$submission_id
NOTARIZATION_STATUS=Accepted
SHA256=$sha256
SIZE=$size
EOF

printf '%s\n' "ZAPVM_MACOS_NOTARIZATION_OK"
printf '%s\n' "submission_id=$submission_id"
printf '%s\n' "sha256=$sha256"
printf '%s\n' "tar=$tar_path"
