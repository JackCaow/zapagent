#!/bin/sh
set -eu

# Sign the staged package once; all distribution channels consume these bytes.
package=${1:?usage: sign-macos-runtime.sh PACKAGE IDENTITY VM_ENTITLEMENTS}
identity=${2:?missing Developer ID identity}
vm_entitlements=${3:?missing virtualization entitlements}
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
case "$identity" in
  "Developer ID Application:"*) ;;
  *) echo "Developer ID Application identity required" >&2; exit 1 ;;
esac
codesign --force --sign "$identity" --timestamp --options runtime \
  --entitlements "$repo/packaging/macos/zap.entitlements" "$package/zap"
codesign --force --sign "$identity" --timestamp --options runtime \
  --entitlements "$vm_entitlements" "$package/zapvm-runtime/bin/zapvm"
for binary in "$package/zap" "$package/zapvm-runtime/bin/zapvm"; do
  codesign --verify --strict --verbose=2 "$binary"
  codesign -dvv "$binary" 2>&1 | grep -q '^Timestamp='
  codesign -dvv "$binary" 2>&1 | grep -q 'flags=.*runtime'
done
