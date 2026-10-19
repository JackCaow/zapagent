#!/bin/sh
set -eu

umask 077

: "${ZAPVM_CONTROL_CONFIG_B64:?ZAPVM_CONTROL_CONFIG_B64 is required}"
: "${ZAPVM_CLIENT_CA_B64:?ZAPVM_CLIENT_CA_B64 is required}"
: "${ZAPVM_CONTROL_CERT_B64:?ZAPVM_CONTROL_CERT_B64 is required}"
: "${ZAPVM_CONTROL_KEY_B64:?ZAPVM_CONTROL_KEY_B64 is required}"

if [ "${PORT:-9444}" != "9444" ]; then
  echo "zapvm Railway service requires PORT=9444" >&2
  exit 64
fi

secret_root=/run/zapvm-control
state_root=/data/state

mkdir -p "$secret_root" "$state_root"
chmod 0700 "$secret_root" /data "$state_root"

decode_secret() {
  encoded=$1
  destination=$2
  printf '%s' "$encoded" | base64 -d >"$destination"
  chmod 0600 "$destination"
}

decode_secret "$ZAPVM_CONTROL_CONFIG_B64" "$secret_root/cloud-control.json"
decode_secret "$ZAPVM_CLIENT_CA_B64" "$secret_root/clients-ca.pem"
decode_secret "$ZAPVM_CONTROL_CERT_B64" "$secret_root/control.pem"
decode_secret "$ZAPVM_CONTROL_KEY_B64" "$secret_root/control.key"

if [ -n "${ZAPVM_ARTIFACT_S3_ACCESS_KEY_B64:-}" ] || [ -n "${ZAPVM_ARTIFACT_S3_SECRET_KEY_B64:-}" ]; then
  : "${ZAPVM_ARTIFACT_S3_ACCESS_KEY_B64:?both Artifact S3 key variables are required}"
  : "${ZAPVM_ARTIFACT_S3_SECRET_KEY_B64:?both Artifact S3 key variables are required}"
  decode_secret "$ZAPVM_ARTIFACT_S3_ACCESS_KEY_B64" "$secret_root/artifact-s3-access-key"
  decode_secret "$ZAPVM_ARTIFACT_S3_SECRET_KEY_B64" "$secret_root/artifact-s3-secret-key"
fi
if [ -n "${ZAPVM_ARTIFACT_S3_SESSION_TOKEN_B64:-}" ]; then
  : "${ZAPVM_ARTIFACT_S3_ACCESS_KEY_B64:?Artifact S3 session token requires access and secret keys}"
  : "${ZAPVM_ARTIFACT_S3_SECRET_KEY_B64:?Artifact S3 session token requires access and secret keys}"
  decode_secret "$ZAPVM_ARTIFACT_S3_SESSION_TOKEN_B64" "$secret_root/artifact-s3-session-token"
fi
if [ -n "${ZAPVM_GITHUB_APP_PRIVATE_KEY_B64:-}" ]; then
  decode_secret "$ZAPVM_GITHUB_APP_PRIVATE_KEY_B64" "$secret_root/github-app-private-key.pem"
fi
if [ -n "${ZAPVM_POSTGRES_DSN_B64:-}" ]; then
  decode_secret "$ZAPVM_POSTGRES_DSN_B64" "$secret_root/postgres-dsn"
fi
if [ -n "${ZAPVM_CREDENTIAL_WRAPPER_KEY_B64:-}" ]; then
  decode_secret "$ZAPVM_CREDENTIAL_WRAPPER_KEY_B64" "$secret_root/credential-wrapper.key"
  if [ "$(wc -c <"$secret_root/credential-wrapper.key" | tr -d ' ')" != 32 ]; then
    echo "ZAPVM_CREDENTIAL_WRAPPER_KEY_B64 must decode to exactly 32 bytes" >&2
    exit 64
  fi
fi
if [ -n "${ZAPVM_NODE_IDENTITY_CA_CERT_B64:-}" ] || [ -n "${ZAPVM_NODE_IDENTITY_CA_KEY_B64:-}" ]; then
  : "${ZAPVM_NODE_IDENTITY_CA_CERT_B64:?both Node identity CA variables are required}"
  : "${ZAPVM_NODE_IDENTITY_CA_KEY_B64:?both Node identity CA variables are required}"
  decode_secret "$ZAPVM_NODE_IDENTITY_CA_CERT_B64" "$secret_root/node-identity-ca.pem"
  decode_secret "$ZAPVM_NODE_IDENTITY_CA_KEY_B64" "$secret_root/node-identity-ca.key"
fi

repair_payload_digests=${ZAPVM_CONTROL_REPAIR_PAYLOAD_DIGESTS:-0}
postgres_migrate=${ZAPVM_POSTGRES_MIGRATE:-0}
unset ZAPVM_CONTROL_CONFIG_B64 ZAPVM_CLIENT_CA_B64 ZAPVM_CONTROL_CERT_B64 ZAPVM_CONTROL_KEY_B64 ZAPVM_CONTROL_REPAIR_PAYLOAD_DIGESTS
unset ZAPVM_ARTIFACT_S3_ACCESS_KEY_B64 ZAPVM_ARTIFACT_S3_SECRET_KEY_B64 ZAPVM_ARTIFACT_S3_SESSION_TOKEN_B64
unset ZAPVM_GITHUB_APP_PRIVATE_KEY_B64
unset ZAPVM_POSTGRES_DSN_B64
unset ZAPVM_CREDENTIAL_WRAPPER_KEY_B64
unset ZAPVM_NODE_IDENTITY_CA_CERT_B64 ZAPVM_NODE_IDENTITY_CA_KEY_B64
unset ZAPVM_POSTGRES_MIGRATE

chown -R zapvm:zapvm "$secret_root" "$state_root"
chown zapvm:zapvm /data

if [ "$repair_payload_digests" = 1 ]; then
  su-exec zapvm:zapvm \
    /usr/local/bin/zapvm-control \
    --config "$secret_root/cloud-control.json" \
    --repair-payload-digests
elif [ "$repair_payload_digests" != 0 ]; then
  echo "ZAPVM_CONTROL_REPAIR_PAYLOAD_DIGESTS must be 0 or 1" >&2
  exit 64
fi

if [ "$postgres_migrate" = 1 ]; then
  if [ -z "${ZAPVM_POSTGRES_DSN:-}" ] && [ -f "$secret_root/postgres-dsn" ]; then
    ZAPVM_POSTGRES_DSN=
    IFS= read -r ZAPVM_POSTGRES_DSN <"$secret_root/postgres-dsn" || [ -n "$ZAPVM_POSTGRES_DSN" ]
    export ZAPVM_POSTGRES_DSN
  fi
  : "${ZAPVM_POSTGRES_DSN:?ZAPVM_POSTGRES_DSN or ZAPVM_POSTGRES_DSN_B64 is required when ZAPVM_POSTGRES_MIGRATE=1}"
  su-exec zapvm:zapvm /usr/local/bin/zapvm-control-db migrate
elif [ "$postgres_migrate" != 0 ]; then
  echo "ZAPVM_POSTGRES_MIGRATE must be 0 or 1" >&2
  exit 64
fi
unset ZAPVM_POSTGRES_DSN

exec su-exec zapvm:zapvm \
  /usr/local/bin/zapvm-control \
  --config "$secret_root/cloud-control.json"
