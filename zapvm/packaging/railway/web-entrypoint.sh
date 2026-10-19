#!/bin/sh
set -eu

umask 077

: "${ZAPVM_WEB_CONFIG_B64:?ZAPVM_WEB_CONFIG_B64 is required}"
: "${ZAPVM_WEB_SIGNING_KEY_B64:?ZAPVM_WEB_SIGNING_KEY_B64 is required}"
: "${ZAPVM_WEB_CONTROL_CA_B64:?ZAPVM_WEB_CONTROL_CA_B64 is required}"
: "${ZAPVM_WEB_CONTROL_CERT_B64:?ZAPVM_WEB_CONTROL_CERT_B64 is required}"
: "${ZAPVM_WEB_CONTROL_KEY_B64:?ZAPVM_WEB_CONTROL_KEY_B64 is required}"

if [ "${PORT:-8080}" != "8080" ]; then
  echo "zapvm Web service requires PORT=8080" >&2
  exit 64
fi

secret_root=/run/zapvm-web
mkdir -p "$secret_root"
chmod 0700 "$secret_root"

decode_secret() {
  encoded=$1
  destination=$2
  printf '%s' "$encoded" | base64 -d >"$destination"
  chmod 0600 "$destination"
}

decode_secret "$ZAPVM_WEB_CONFIG_B64" "$secret_root/web-bff.json"
decode_secret "$ZAPVM_WEB_SIGNING_KEY_B64" "$secret_root/web-cookie-signing.key"
decode_secret "$ZAPVM_WEB_CONTROL_CA_B64" "$secret_root/control-ca.pem"
decode_secret "$ZAPVM_WEB_CONTROL_CERT_B64" "$secret_root/control-client.pem"
decode_secret "$ZAPVM_WEB_CONTROL_KEY_B64" "$secret_root/control-client.key"

unset ZAPVM_WEB_CONFIG_B64 ZAPVM_WEB_SIGNING_KEY_B64 ZAPVM_WEB_CONTROL_CA_B64
unset ZAPVM_WEB_CONTROL_CERT_B64 ZAPVM_WEB_CONTROL_KEY_B64

chown -R zapvm:zapvm "$secret_root"

su-exec zapvm:zapvm \
  /usr/local/bin/zapvm-web \
  --config "$secret_root/web-bff.json" \
  --validate

exec su-exec zapvm:zapvm \
  /usr/local/bin/zapvm-web \
  --config "$secret_root/web-bff.json"
