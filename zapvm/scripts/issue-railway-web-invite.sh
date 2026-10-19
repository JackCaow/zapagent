#!/bin/sh
# Print a short-lived zapVM Workspace invitation URL for a Railway deployment.
# The output is a bearer credential: send it only through a private channel.
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 <railway-project-id> <user-id> [workspace-id] [ttl]" >&2
  exit 64
fi

railway_project=$1
invite_user=$2
workspace_id=${3:-acme-default}
invite_ttl=${4:-24h}
script_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
secret_root=$(mktemp -d "${TMPDIR:-/tmp}/zapvm-web-invite.XXXXXX")

cleanup() {
  rm -rf "$secret_root"
}
trap cleanup EXIT HUP INT TERM
umask 077

decode_base64() {
  base64 -d 2>/dev/null || base64 -D
}

read_secret() {
  name=$1
  destination=$2
  railway variables --project "$railway_project" --environment production --service zapvm-web --json \
    | jq -r --arg name "$name" '.[$name] // empty' \
    | decode_base64 >"$destination"
  test -s "$destination"
  chmod 600 "$destination"
}

read_secret ZAPVM_WEB_CONFIG_B64 "$secret_root/source-config.json"
read_secret ZAPVM_WEB_SIGNING_KEY_B64 "$secret_root/signing.key"
read_secret ZAPVM_WEB_CONTROL_CA_B64 "$secret_root/control-ca.pem"
read_secret ZAPVM_WEB_CONTROL_CERT_B64 "$secret_root/control-client.pem"
read_secret ZAPVM_WEB_CONTROL_KEY_B64 "$secret_root/control-client.key"

jq --arg root "$secret_root" '
  .signing_key_file = ($root + "/signing.key")
  | .projects |= map(
      .server_ca = ($root + "/control-ca.pem")
      | .certificate = ($root + "/control-client.pem")
      | .private_key = ($root + "/control-client.key")
    )
' "$secret_root/source-config.json" >"$secret_root/web-bff.json"
chmod 600 "$secret_root/web-bff.json"

go run "$script_root/cmd/zapvm-web" \
  --config "$secret_root/web-bff.json" \
  --issue-invite \
  --invite-project "$workspace_id" \
  --invite-user "$invite_user" \
  --invite-ttl "$invite_ttl"
