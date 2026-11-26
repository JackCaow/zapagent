#!/bin/sh
set -e

REPO="JackCaow/zapagent"
BIN="zap"
GITHUB_AUTH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
INSTALL_DIR="${ZAP_INSTALL_DIR:-/usr/local/bin}"
NEEDS_SUDO=1
if [ -n "${ZAP_INSTALL_DIR:-}" ]; then
  NEEDS_SUDO=0
fi

# Detect OS and arch
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64) FILE="zap-linux-x64" ;;
      aarch64|arm64) FILE="zap-linux-arm64" ;;
      *) echo "Unsupported architecture: $ARCH" && exit 1 ;;
    esac
    ;;
  Darwin)
    case "$ARCH" in
      x86_64) FILE="zap-macos-x64" ;;
      arm64)  FILE="zap-macos-arm64" ;;
      *) echo "Unsupported architecture: $ARCH" && exit 1 ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*)
    FILE="zap-windows-x64.exe"
    BIN="zap.exe"
    HOME_DIR="${HOME:-${USERPROFILE:-}}"
    if [ -z "$HOME_DIR" ]; then
      echo "Could not determine home directory for Windows install"
      exit 1
    fi
    INSTALL_DIR="${ZAP_INSTALL_DIR:-$HOME_DIR/bin}"
    NEEDS_SUDO=0
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

github_download() {
  if [ -n "$GITHUB_AUTH_TOKEN" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_AUTH_TOKEN" -H "Accept: application/octet-stream" "$1" -o "$2"
  else
    curl -fsSL -H "Accept: application/octet-stream" "$1" -o "$2"
  fi
}

github_text() {
  if [ -n "$GITHUB_AUTH_TOKEN" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_AUTH_TOKEN" -H "Accept: application/vnd.github+json" "$1"
  else
    curl -fsSL "$1"
  fi
}

# Get latest release tag. Private installations must provide GH_TOKEN or
# GITHUB_TOKEN with read access to JackCaow/zapagent.
RELEASE_JSON=$(github_text "https://api.github.com/repos/$REPO/releases/latest")
TAG=$(printf "%s\n" "$RELEASE_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
if [ -z "$TAG" ]; then
  echo "Could not determine latest release tag for $REPO"
  exit 1
fi

release_asset_url() {
  # Private-repository browser download URLs return 404 even with a token.
  # Resolve the authenticated Release Asset API URL from the release response.
  asset_name="$1"
  printf "%s" "$RELEASE_JSON" |
    tr -d '\n' |
    tr '{' '\n' |
    sed 's/"name"[[:space:]]*:[[:space:]]*/"name":/g' |
    grep -F "\"name\":\"$asset_name\"" |
    sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(https:\/\/api.github.com\/repos\/[^\"]*\/releases\/assets\/[0-9][0-9]*\)".*/\1/p' |
    head -n 1
}

URL=$(release_asset_url "$FILE")
CHECKSUM_URL=$(release_asset_url "$FILE.sha256")
if [ -z "$URL" ] || [ -z "$CHECKSUM_URL" ]; then
  echo "Release $TAG is missing $FILE or its checksum" >&2
  exit 1
fi
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zap-install.XXXXXX")
TMP_FILE="$TMP_ROOT/$FILE"
CHECKSUM_FILE="$TMP_ROOT/$FILE.sha256"
trap 'rm -rf "$TMP_ROOT"' EXIT

# zapVM is installed separately (github.com/JackCaow/zapVM); an existing
# runtime under the data directory is left untouched.
echo "Downloading Zap $TAG for $OS/$ARCH..."
github_download "$URL" "$TMP_FILE"
github_download "$CHECKSUM_URL" "$CHECKSUM_FILE"

EXPECTED_SHA=$(awk '{print $1}' "$CHECKSUM_FILE" | head -n 1)
if [ -z "$EXPECTED_SHA" ]; then
  echo "Could not read checksum for $FILE"
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA=$(sha256sum "$TMP_FILE" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA=$(shasum -a 256 "$TMP_FILE" | awk '{print $1}')
else
  echo "Neither sha256sum nor shasum is available to verify $FILE"
  exit 1
fi
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "Checksum verification failed for $FILE"
  echo "Expected: $EXPECTED_SHA"
  echo "Actual:   $ACTUAL_SHA"
  exit 1
fi

chmod +x "$TMP_FILE"

echo "Installing to $INSTALL_DIR/$BIN..."
if [ ! -d "$INSTALL_DIR" ]; then
  if [ "$NEEDS_SUDO" = "1" ]; then
    sudo mkdir -p "$INSTALL_DIR"
  else
    mkdir -p "$INSTALL_DIR"
  fi
fi

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP_FILE" "$INSTALL_DIR/$BIN"
elif [ "$NEEDS_SUDO" = "1" ]; then
  sudo mv "$TMP_FILE" "$INSTALL_DIR/$BIN"
else
  echo "Install directory is not writable: $INSTALL_DIR"
  exit 1
fi

echo "Done! Run: zap"
