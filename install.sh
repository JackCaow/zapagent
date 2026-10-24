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

RUNTIME_FILE="$FILE.runtime.tar.gz"
URL=$(release_asset_url "$FILE")
CHECKSUM_URL=$(release_asset_url "$FILE.sha256")
RUNTIME_URL=$(release_asset_url "$RUNTIME_FILE")
RUNTIME_CHECKSUM_URL=$(release_asset_url "$RUNTIME_FILE.sha256")
if [ -z "$URL" ] || [ -z "$CHECKSUM_URL" ]; then
  echo "Release $TAG is missing $FILE or its checksum" >&2
  exit 1
fi
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zap-install.XXXXXX")
TMP_FILE="$TMP_ROOT/$FILE"
CHECKSUM_FILE="$TMP_ROOT/$FILE.sha256"
RUNTIME_ARCHIVE="$TMP_ROOT/$RUNTIME_FILE"
RUNTIME_CHECKSUM="$TMP_ROOT/$RUNTIME_FILE.sha256"
RUNTIME_PACKAGE="$TMP_ROOT/runtime-package"
trap 'rm -rf "$TMP_ROOT"' EXIT

echo "Downloading Zap $TAG for $OS/$ARCH..."
HAS_RUNTIME=0
if [ -n "$RUNTIME_URL" ] && [ -n "$RUNTIME_CHECKSUM_URL" ]; then
  github_download "$RUNTIME_URL" "$RUNTIME_ARCHIVE"
  github_download "$RUNTIME_CHECKSUM_URL" "$RUNTIME_CHECKSUM"
  EXPECTED_RUNTIME_SHA=$(awk '{print $1}' "$RUNTIME_CHECKSUM" | head -n 1)
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_RUNTIME_SHA=$(sha256sum "$RUNTIME_ARCHIVE" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_RUNTIME_SHA=$(shasum -a 256 "$RUNTIME_ARCHIVE" | awk '{print $1}')
  else
    echo "Neither sha256sum nor shasum is available to verify $RUNTIME_FILE"
    exit 1
  fi
  if [ -z "$EXPECTED_RUNTIME_SHA" ] || [ "$ACTUAL_RUNTIME_SHA" != "$EXPECTED_RUNTIME_SHA" ]; then
    echo "Checksum verification failed for $RUNTIME_FILE"
    exit 1
  fi
  mkdir -p "$RUNTIME_PACKAGE"
  tar -xzf "$RUNTIME_ARCHIVE" -C "$RUNTIME_PACKAGE"
  TMP_FILE="$RUNTIME_PACKAGE/$BIN"
  test -f "$TMP_FILE" || { echo "Runtime package is missing $BIN" >&2; exit 1; }
  test -f "$RUNTIME_PACKAGE/zapvm-runtime/image-public.pem" || { echo "Runtime package is missing image public key" >&2; exit 1; }
  test -f "$RUNTIME_PACKAGE/zapvm-runtime/images/active.json" || { echo "Runtime package is missing active signed image" >&2; exit 1; }
  HAS_RUNTIME=1
else
  echo "Runtime package is unavailable for $TAG; installing the standalone CLI."
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
fi

chmod +x "$TMP_FILE"

if [ "$HAS_RUNTIME" = 1 ]; then
  case "$OS" in
    Linux) DATA_DIR="${ZAPCODE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/zapcode}" ;;
    Darwin) DATA_DIR="${ZAPCODE_DATA_DIR:-$HOME/.zapcode}" ;;
    MINGW*|MSYS*|CYGWIN*) DATA_DIR="${ZAPCODE_DATA_DIR:-${APPDATA:-$HOME}/zapcode}" ;;
  esac
  RUNTIME_PARENT="$DATA_DIR/runtime"
  RUNTIME_DEST="$RUNTIME_PARENT/zapvm"
  RUNTIME_BACKUP="$RUNTIME_PARENT/.zapvm-previous-$$"
  mkdir -p "$RUNTIME_PARENT"
  case "$OS" in
    Linux|Darwin)
      OLD_ZAPVM="$RUNTIME_DEST/bin/zapvm"
      DAEMON_ENDPOINT="$DATA_DIR/runtime-state/zapvm/daemon.sock"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      OLD_ZAPVM="$RUNTIME_DEST/bin/zapvm.exe"
      DAEMON_ENDPOINT='\\.\pipe\zapvm-zapcode'
      ;;
  esac
  if [ -f "$OLD_ZAPVM" ] && "$OLD_ZAPVM" daemon status --endpoint "$DAEMON_ENDPOINT" >/dev/null 2>&1; then
    echo "Stopping the existing zapVM daemon before runtime replacement..."
    "$OLD_ZAPVM" daemon stop --endpoint "$DAEMON_ENDPOINT" >/dev/null 2>&1 || true
    DAEMON_STOPPED=0
    for attempt in 1 2 3 4 5; do
      if ! "$OLD_ZAPVM" daemon status --endpoint "$DAEMON_ENDPOINT" >/dev/null 2>&1; then
        DAEMON_STOPPED=1
        break
      fi
      sleep 1
    done
    if [ "$DAEMON_STOPPED" != 1 ]; then
      echo "Existing zapVM daemon did not stop; runtime was not replaced" >&2
      exit 1
    fi
  fi
  if [ -e "$RUNTIME_DEST" ]; then
    mv "$RUNTIME_DEST" "$RUNTIME_BACKUP"
  fi
  if mv "$RUNTIME_PACKAGE/zapvm-runtime" "$RUNTIME_DEST"; then
    rm -rf "$RUNTIME_BACKUP"
  else
    if [ -e "$RUNTIME_BACKUP" ]; then mv "$RUNTIME_BACKUP" "$RUNTIME_DEST"; fi
    echo "Could not install zapVM runtime" >&2
    exit 1
  fi
fi

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

if [ "$HAS_RUNTIME" = 1 ]; then
  case "$OS" in
    MINGW*|MSYS*|CYGWIN*)
      if ! "$RUNTIME_DEST/bin/zapvm.exe" service status >/dev/null 2>&1; then
        if ! "$RUNTIME_DEST/bin/zapvm.exe" service install; then
          echo "Windows zapVM service installation requires an Administrator terminal." >&2
          exit 1
        fi
      fi
      ;;
  esac
fi

echo "Done! Run: zap"
