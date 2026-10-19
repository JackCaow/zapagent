#!/usr/bin/env bash
set -euo pipefail

required=(
  ZAPVM_CONTROL_URL
  ZAPVM_CA
  ZAPVM_CLIENT_CERT
  ZAPVM_CLIENT_KEY
  ZAPVM_ADMIN_CERT
  ZAPVM_ADMIN_KEY
  ZAPVM_TURN_ONE_ID
  ZAPVM_TURN_TWO_ID
  ZAPVM_EXPECTED_TOKEN
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required environment variable: %s\n' "$name" >&2
    exit 2
  fi
done

client_curl=(
  curl --silent --show-error --fail-with-body
  --cacert "$ZAPVM_CA"
  --cert "$ZAPVM_CLIENT_CERT"
  --key "$ZAPVM_CLIENT_KEY"
)
admin_curl=(
  curl --silent --show-error --fail-with-body
  --cacert "$ZAPVM_CA"
  --cert "$ZAPVM_ADMIN_CERT"
  --key "$ZAPVM_ADMIN_KEY"
)

printf 'resident acceptance: control health\n'
"${admin_curl[@]}" "$ZAPVM_CONTROL_URL/healthz" |
  jq -e '.status == "ok"' >/dev/null

printf 'resident acceptance: node online\n'
"${admin_curl[@]}" "$ZAPVM_CONTROL_URL/v1/admin/nodes" |
  jq -e '.nodes[] | select(.id == "host-a" and .state == "online")' >/dev/null

for task_id in "$ZAPVM_TURN_ONE_ID" "$ZAPVM_TURN_TWO_ID"; do
  printf 'resident acceptance: task %s succeeded\n' "$task_id"
  "${client_curl[@]}" "$ZAPVM_CONTROL_URL/v1/agent/sessions/$task_id" |
    jq -e '.state == "succeeded"' >/dev/null
done

events=$("${client_curl[@]}" \
  "$ZAPVM_CONTROL_URL/v1/agent/sessions/$ZAPVM_TURN_TWO_ID/events?after=0&limit=1000")

init=$(jq -r '
  .events[]
  | select(.type == "exec.output" and .stream == "stdout")
  | .data | @base64d | fromjson?
  | select(.type == "system" and .subtype == "init")
' <<<"$events")
result=$(jq -r '
  .events[]
  | select(.type == "exec.output" and .stream == "stdout")
  | .data | @base64d | fromjson?
  | select(.type == "result")
' <<<"$events")

printf 'resident acceptance: continuation linkage\n'
jq -e '.resumedFrom | type == "string" and length > 0' <<<"$init" >/dev/null

printf 'resident acceptance: restored token and final marker\n'
jq -e --arg token "$ZAPVM_EXPECTED_TOKEN" '
  .ok == true
  and (.toolCalls | length == 0)
  and (.text | contains($token))
  and (.text | contains("RESIDENT_AGENT_CONTINUE_OK"))
' <<<"$result" >/dev/null

printf 'RESIDENT_AGENT_ACCEPTANCE_OK\n'
