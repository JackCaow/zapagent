#!/bin/sh
set -eu

usage() {
  echo "usage: $0 <version-without-v> <new-output-directory>" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
version=$1
output=$2

case "$version" in
  ''|*[!0-9A-Za-z.-]*) usage ;;
esac
case "$output" in
  /*) ;;
  *) echo "output directory must be absolute" >&2; exit 64 ;;
esac
if [ -e "$output" ]; then
  echo "output directory already exists: $output" >&2
  exit 73
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
git_sha=$(git -C "$repo_root" rev-parse HEAD)
mkdir -p "$output"

build_target() {
  goos=$1
  goarch=$2
  archive_kind=$3
  target="zapvm-cloud-$version-$goos-$goarch"
  stage="$output/$target"
  mkdir -p "$stage/bin" "$stage/config" "$stage/docs" "$stage/service"

  suffix=
  cgo_enabled=0
  if [ "$goos" = windows ]; then
    suffix=.exe
  elif [ "$goos" = darwin ]; then
    host_goos=$(go env GOOS)
    host_goarch=$(go env GOARCH)
    if [ "$host_goos" != "$goos" ] || [ "$host_goarch" != "$goarch" ]; then
      echo "darwin/$goarch must be built natively because Virtualization.framework requires cgo" >&2
      exit 69
    fi
    cgo_enabled=1
  fi
  for command in zapvm-control zapvm-control-db zapvm-node zapvm-web; do
    package="./cmd/$command"
    ldflags="-s -w"
    case "$command" in
      zapvm-control|zapvm-node|zapvm-web) ldflags="$ldflags -X main.version=$version" ;;
    esac
    (
      cd "$repo_root"
      CGO_ENABLED="$cgo_enabled" GOOS="$goos" GOARCH="$goarch" \
        go build -trimpath -ldflags "$ldflags" -o "$stage/bin/$command$suffix" "$package"
    )
  done

  cp "$repo_root/packaging/examples/cloud-control.json" "$stage/config/"
  cp "$repo_root/packaging/examples/cloud-control.railway.json" "$stage/config/"
  cp "$repo_root/packaging/examples/cloud-node.json" "$stage/config/"
  cp "$repo_root/packaging/examples/cloud-node-managed.json" "$stage/config/"
  cp "$repo_root/packaging/examples/web-bff.json" "$stage/config/"
  cp "$repo_root/docs/cloud-agent.md" "$stage/docs/"
  cp "$repo_root/docs/web-bff.md" "$stage/docs/"
  cp "$repo_root/docs/railway.md" "$stage/docs/"
  cp "$repo_root/docs/node-operations.md" "$stage/docs/"
  cp "$repo_root/docs/acceptance-web-agent-macos.md" "$stage/docs/"
  if [ "$goos" = linux ]; then
    cp "$repo_root/packaging/systemd/zapvm-control.service" "$stage/service/"
    cp "$repo_root/packaging/systemd/zapvm-node.service" "$stage/service/"
    cp "$repo_root/packaging/systemd/zapvm-web.service" "$stage/service/"
  elif [ "$goos" = darwin ]; then
    cp "$repo_root/packaging/macos/com.zapvm.node.plist.example" "$stage/service/"
  fi

  {
    echo "version=$version"
    echo "git_sha=$git_sha"
    echo "goos=$goos"
    echo "goarch=$goarch"
  } >"$stage/BUILD-INFO"

  case "$archive_kind" in
    tar)
      tar -C "$output" -czf "$output/$target.tar.gz" "$target"
      ;;
    zip)
      (cd "$output" && zip -q -r "$target.zip" "$target")
      ;;
    *) usage ;;
  esac
  rm -rf -- "$stage"
}

build_target darwin arm64 tar
build_target linux amd64 tar
build_target linux arm64 tar
build_target windows amd64 zip

(
  cd "$output"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./*.tar.gz ./*.zip >SHA256SUMS
  else
    shasum -a 256 ./*.tar.gz ./*.zip >SHA256SUMS
  fi
)

echo "ZAPVM_CLOUD_RELEASE_OK version=$version git_sha=$git_sha output=$output"
