#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=${1:-}

if [[ -n "$mode" && "$mode" != "--real-vm" ]]; then
  printf 'usage: %s [--real-vm]\n' "$0" >&2
  exit 2
fi

cd "$repository_root"

printf 'cloud development acceptance: mTLS Control -> Node -> daemon RPC -> cursor replay\n'
go test -count=1 -run '^TestDevelopmentE2EControlNodeDaemonAndCursorReplay$' -v ./internal/cloudnode
printf 'CLOUD_DEVELOPMENT_E2E_OK\n'

if [[ "$mode" == "--real-vm" ]]; then
  printf 'cloud development acceptance: signed Guest VM and Resident Agent\n'
  exec "$script_dir/verify-resident-agent.sh"
fi
