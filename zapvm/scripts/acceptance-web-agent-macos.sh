#!/bin/bash
set -euo pipefail

umask 077

if [[ $(uname -s) != Darwin ]]; then
  echo "macOS is required" >&2
  exit 1
fi
if [[ $# -ne 6 ]]; then
  echo "usage: acceptance-web-agent-macos.sh IMAGE_ROOT IMAGE_PUBLIC_KEY AGENT_ROOT AGENT_PUBLIC_KEY AGENT_REFERENCE EVIDENCE_DIR" >&2
  exit 2
fi

image_root=$1
image_public_key=$2
agent_root=$3
agent_public_key=$4
agent_reference=$5
evidence_dir=$6
model_key_file=${ZAPVM_E2E_MODEL_KEY_FILE:-}
provider_base_url=${ZAPVM_E2E_PROVIDER_BASE_URL:-}
model=${ZAPVM_E2E_MODEL:-}

for tool in go openssl curl jq git codesign node npm shasum; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
[[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] || { echo "Google Chrome is required" >&2; exit 1; }
NODE_PATH=$(npm root -g) node -e 'require("playwright")' >/dev/null 2>&1 || { echo "global Playwright is required" >&2; exit 1; }
[[ -d $image_root && -f $image_public_key && -d $agent_root && -f $agent_public_key && -f $model_key_file ]] || { echo "signed Runtime, Agent, or model credential input is missing" >&2; exit 1; }
[[ $agent_reference == *@* ]] || { echo "Agent reference must be id@version" >&2; exit 1; }
[[ $provider_base_url == https://* && -n $model ]] || { echo "ZAPVM_E2E_PROVIDER_BASE_URL and ZAPVM_E2E_MODEL are required" >&2; exit 1; }
case "$image_root:$image_public_key:$agent_root:$agent_public_key:$model_key_file:$evidence_dir" in
  *$'\n'*|*\"*|*\#*) echo "paths cannot contain newlines, quotes, or #" >&2; exit 1 ;;
esac
case "$image_root:$image_public_key:$agent_root:$agent_public_key:$model_key_file:$evidence_dir" in
  /*:/*:/*:/*:/*:/*) ;;
  *) echo "all paths must be absolute" >&2; exit 1 ;;
esac
case "$evidence_dir" in
  "$HOME"/*) ;;
  *) echo "evidence directory must remain inside HOME" >&2; exit 1 ;;
esac
[[ ! -e $evidence_dir ]] || { echo "evidence directory already exists" >&2; exit 1; }

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
active_image_version=$(jq -er '.active_version | select(type == "string" and length > 0)' "$image_root/active.json")
active_manifest="$image_root/$active_image_version/manifest.json"
[[ -f $active_manifest ]] || { echo "active signed image manifest is missing" >&2; exit 1; }
active_manifest_sha256=$(shasum -a 256 "$active_manifest" | awk '{print $1}')
source_dirty=false
if [[ -n $(git -C "$repository_root" status --porcelain --untracked-files=all) ]]; then source_dirty=true; fi
provider_domain=$(ZAPVM_PROVIDER_URL="$provider_base_url" node -e 'const value=new URL(process.env.ZAPVM_PROVIDER_URL); if(value.protocol!=="https:") process.exit(1); process.stdout.write(value.hostname)')
mkdir -m 700 -p "$evidence_dir"
runtime_dir=$(mktemp -d "$HOME/.zapvm-e2e.XXXXXX")
chmod 700 "$runtime_dir"
fixture="$runtime_dir"
workspace="$fixture/workspace"
bin="$fixture/bin"
mkdir -m 700 -p "$fixture" "$workspace" "$bin" "$fixture/control-state" "$fixture/daemon-state"

control_pid=
daemon_pid=
node_pid=
web_pid=
raw_logs=(control daemon node web)

stop_process() {
  local pid=$1
  if [[ -n $pid ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..100}; do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  if [[ -n $pid ]]; then wait "$pid" >/dev/null 2>&1 || true; fi
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  stop_process "$web_pid"
  stop_process "$node_pid"
  stop_process "$daemon_pid"
  stop_process "$control_pid"
  for name in "${raw_logs[@]}"; do
    if [[ -f "$evidence_dir/$name.raw.log" ]]; then
      sed -e "s#$evidence_dir#<EVIDENCE_ROOT>#g" -e "s#$runtime_dir#<RUNTIME_ROOT>#g" -e "s#$model_key_file#<MODEL_KEY_FILE>#g" \
        "$evidence_dir/$name.raw.log" >"$evidence_dir/$name.log"
      chmod 600 "$evidence_dir/$name.log"
      rm -f "$evidence_dir/$name.raw.log"
    fi
  done
  case "$runtime_dir" in
    "$HOME"/.zapvm-e2e.*) rm -rf -- "$runtime_dir" ;;
    *) echo "refusing to remove unexpected runtime directory" >&2; status=1 ;;
  esac
  if [[ $status -eq 0 ]]; then
    echo "WEB_AGENT_MACOS_E2E_OK evidence=$evidence_dir"
  else
    echo "WEB_AGENT_MACOS_E2E_FAILED evidence=$evidence_dir" >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

pick_port() {
  local start=$1
  local port
  for ((port=start; port<start+200; port++)); do
    if ! /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$port"
      return
    fi
  done
  return 1
}

control_port=$(pick_port $((21000 + $$ % 1000)))
web_port=$(pick_port $((control_port + 201)))
control_url="https://127.0.0.1:$control_port"
web_url="http://127.0.0.1:$web_port"
endpoint="$fixture/daemon.sock"

echo "building P0 binaries"
(cd "$repository_root" && go build -trimpath -ldflags "-X main.version=e2e-$(git rev-parse --short HEAD)" -o "$bin/zapvm" ./cmd/zapvm)
(cd "$repository_root" && go build -trimpath -ldflags "-X main.version=e2e-$(git rev-parse --short HEAD)" -o "$bin/zapvm-control" ./cmd/zapvm-control)
(cd "$repository_root" && go build -trimpath -ldflags "-X main.version=e2e-$(git rev-parse --short HEAD)" -o "$bin/zapvm-node" ./cmd/zapvm-node)
(cd "$repository_root" && go build -trimpath -ldflags "-X main.version=e2e-$(git rev-parse --short HEAD)" -o "$bin/zapvm-web" ./cmd/zapvm-web)
codesign --force --sign - --entitlements "$repository_root/packaging/macos/zapvm.entitlements" "$bin/zapvm" >/dev/null
codesign --force --sign - "$bin/zapvm-control" "$bin/zapvm-node" "$bin/zapvm-web" >/dev/null

cat >"$fixture/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ca
prompt = no
[dn]
CN = zapVM Web Agent E2E CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$fixture/ca.cnf" -keyout "$fixture/ca.key" -out "$fixture/ca.pem" >/dev/null 2>&1

issue_certificate() {
  local name=$1 uri=$2 usage=$3 extra_san=${4:-}
  cat >"$fixture/$name.cnf" <<EOF
[req]
distinguished_name = dn
req_extensions = identity
prompt = no
[dn]
CN = $name
[identity]
subjectAltName = URI:$uri$extra_san
keyUsage = critical,digitalSignature
extendedKeyUsage = $usage
EOF
  cat >"$fixture/$name-ext.cnf" <<EOF
subjectAltName = URI:$uri$extra_san
keyUsage = critical,digitalSignature
extendedKeyUsage = $usage
EOF
  openssl req -newkey rsa:2048 -nodes -config "$fixture/$name.cnf" -keyout "$fixture/$name.key" -out "$fixture/$name.csr" >/dev/null 2>&1
  if [[ -f $fixture/ca.srl ]]; then
    openssl x509 -req -days 1 -in "$fixture/$name.csr" -CA "$fixture/ca.pem" -CAkey "$fixture/ca.key" -CAserial "$fixture/ca.srl" -extfile "$fixture/$name-ext.cnf" -out "$fixture/$name.pem" >/dev/null 2>&1
  else
    openssl x509 -req -days 1 -in "$fixture/$name.csr" -CA "$fixture/ca.pem" -CAkey "$fixture/ca.key" -CAcreateserial -extfile "$fixture/$name-ext.cnf" -out "$fixture/$name.pem" >/dev/null 2>&1
  fi
}

issue_certificate control spiffe://e2e.zapvm.test/control/primary serverAuth ",IP:127.0.0.1"
issue_certificate node spiffe://e2e.zapvm.test/node/host-e2e clientAuth
issue_certificate operator spiffe://e2e.zapvm.test/tenant/acme/project/default/client/browser clientAuth
issue_certificate outsider spiffe://e2e.zapvm.test/tenant/beta/project/default/client/outsider clientAuth

cat >"$fixture/control.json" <<EOF
{
  "schema_version": 1,
  "listen": "127.0.0.1:$control_port",
  "state_root": "$fixture/control-state",
  "trust_domain": "e2e.zapvm.test",
  "control_id": "primary",
  "client_ca": "$fixture/ca.pem",
  "certificate": "$fixture/control.pem",
  "private_key": "$fixture/control.key",
  "heartbeat_ttl_seconds": 10,
  "lease_ttl_seconds": 30,
  "administrators": ["spiffe://e2e.zapvm.test/tenant/acme/project/default/client/browser"],
  "nodes": [{
    "id": "host-e2e",
    "capacity": 2,
    "scopes": [{"tenant_id":"acme","project_id":"default"}],
    "computers": [{"id":"computer-e2e","tenant_id":"acme","project_id":"default","agent":"$agent_reference"}]
  }]
}
EOF
cat >"$fixture/node.json" <<EOF
{
  "schema_version": 1,
  "control_url": "$control_url",
  "trust_domain": "e2e.zapvm.test",
  "control_id": "primary",
  "node_id": "host-e2e",
  "server_ca": "$fixture/ca.pem",
  "certificate": "$fixture/node.pem",
  "private_key": "$fixture/node.key",
  "daemon_endpoint": "$endpoint",
  "workspace_root": "$fixture/workspaces",
  "poll_ms": 500,
  "max_concurrent": 2
}
EOF

web_access_token=$(openssl rand -hex 32)
web_access_hash=$(printf '%s' "$web_access_token" | shasum -a 256 | awk '{print $1}')
openssl rand -hex 32 >"$fixture/web-signing.key"
cat >"$fixture/web.json" <<EOF
{
  "schema_version": 1,
  "listen": "127.0.0.1:$web_port",
  "public_origin": "$web_url",
  "development_http": true,
  "cookie_name": "zapvm_e2e_session",
  "signing_key_file": "$fixture/web-signing.key",
  "session_seconds": 3600,
  "projects": [{
    "id": "default",
    "user_id": "browser",
    "display_name": "E2E",
    "access_token_sha256": "$web_access_hash",
    "control_url": "$control_url",
    "server_ca": "$fixture/ca.pem",
    "certificate": "$fixture/operator.pem",
    "private_key": "$fixture/operator.key",
    "client_uri": "spiffe://e2e.zapvm.test/tenant/acme/project/default/client/browser",
    "control_uri": "spiffe://e2e.zapvm.test/control/primary",
    "runtime_profile": {
      "id": "default",
      "display_name": "E2E Agent",
      "provider_base_url": "$provider_base_url",
      "model": "$model",
      "model_credential_id": "model-api-key",
      "max_turns": 80,
      "timeout_seconds": 7200
    }
  }]
}
EOF
chmod 600 "$fixture"/*.json "$fixture"/*.key

printf 'E2E_BASELINE\n' >"$workspace/README.md"
git -C "$workspace" init -q
git -C "$workspace" -c user.name=zapvm-e2e -c user.email=e2e@zapvm.invalid add README.md
git -C "$workspace" -c user.name=zapvm-e2e -c user.email=e2e@zapvm.invalid commit -q -m baseline

"$bin/zapvm-control" --config "$fixture/control.json" >"$evidence_dir/control.raw.log" 2>&1 &
control_pid=$!
"$bin/zapvm" daemon serve \
  --endpoint "$endpoint" --image-root "$image_root" --image-public-key "$image_public_key" \
  --agent-root "$agent_root" --agent-public-key "$agent_public_key" \
  --state-root "$fixture/daemon-state" --max-workers 2 --max-per-workspace 1 --idle-timeout 5m \
  --cpus 2 --memory-mib 2048 --credential "model-api-key=$model_key_file" \
  >"$evidence_dir/daemon.raw.log" 2>&1 &
daemon_pid=$!

for _ in {1..200}; do
  if "$bin/zapvm" daemon status --endpoint "$endpoint" >/dev/null 2>&1; then break; fi
  kill -0 "$daemon_pid" >/dev/null 2>&1 || { echo "daemon exited during startup" >&2; exit 1; }
  sleep 0.1
done
"$bin/zapvm" daemon status --endpoint "$endpoint" >/dev/null
"$bin/zapvm" computer create --endpoint "$endpoint" --id computer-e2e --workspace "$workspace" \
  --agent "$agent_reference" --network unrestricted --cpus 2 --memory-mib 2048 \
  | jq '{id,network,allowed_domains,allowed_ports,cpus,memory_mib,runtime_state}' >"$evidence_dir/computer.json"
jq -e --arg agent "$agent_reference" '.agent == $agent' <("$bin/zapvm" computer inspect --endpoint "$endpoint" computer-e2e) >/dev/null

"$bin/zapvm-node" --config "$fixture/node.json" >"$evidence_dir/node.raw.log" 2>&1 &
node_pid=$!
"$bin/zapvm-web" --config "$fixture/web.json" >"$evidence_dir/web.raw.log" 2>&1 &
web_pid=$!

admin_curl=(curl --silent --show-error --fail-with-body --cacert "$fixture/ca.pem" --cert "$fixture/operator.pem" --key "$fixture/operator.key")
for _ in {1..200}; do
  if "${admin_curl[@]}" "$control_url/readyz" >/dev/null 2>&1 && curl --silent --fail "$web_url/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$control_pid" >/dev/null 2>&1 || { echo "control exited during startup" >&2; exit 1; }
  kill -0 "$node_pid" >/dev/null 2>&1 || { echo "node exited during startup" >&2; exit 1; }
  kill -0 "$web_pid" >/dev/null 2>&1 || { echo "web exited during startup" >&2; exit 1; }
  sleep 0.1
done
"${admin_curl[@]}" "$control_url/readyz" | jq -e '.status == "ready"' >/dev/null

for _ in {1..200}; do
  if "${admin_curl[@]}" "$control_url/v1/admin/nodes" | jq -e '.nodes[] | select(.id == "host-e2e" and .state == "online" and .daemon_state == "healthy")' >/dev/null 2>&1; then break; fi
  sleep 0.25
done
"${admin_curl[@]}" "$control_url/v1/admin/nodes" | jq -e '.nodes[] | select(.id == "host-e2e" and .state == "online" and .daemon_state == "healthy")' >/dev/null

ZAPVM_E2E_WEB_URL="$web_url" \
ZAPVM_E2E_ACCESS_TOKEN="$web_access_token" \
ZAPVM_E2E_PROVIDER_BASE_URL="$provider_base_url" \
ZAPVM_E2E_MODEL="$model" \
ZAPVM_E2E_EVIDENCE_DIR="$evidence_dir" \
NODE_PATH=$(npm root -g) \
node "$repository_root/scripts/acceptance-web-agent-browser.cjs"
jq -e '.final_state == "passed" and .mobile.state == "passed" and .mobile.horizontal_overflow == false and .mobile.drawers == "passed"' "$evidence_dir/browser-result.json" >/dev/null

first_id=$(jq -r '.tasks.first' "$evidence_dir/browser-result.json")
continue_id=$(jq -r '.tasks.continue' "$evidence_dir/browser-result.json")
cancel_id=$(jq -r '.tasks.cancel' "$evidence_dir/browser-result.json")
for task_id in "$first_id" "$continue_id"; do
  "${admin_curl[@]}" "$control_url/v1/agent/sessions/$task_id" | jq -e '.state == "succeeded"' >/dev/null
done
"${admin_curl[@]}" "$control_url/v1/agent/sessions/$cancel_id" | jq -e '.state == "canceled"' >/dev/null
[[ ! -e $workspace/.zapcode ]] || { echo "temporary .zapcode protection placeholder was not cleaned" >&2; exit 1; }
[[ ! -e $workspace/.git/zapvm-e2e-forbidden ]] || { echo "Agent wrote into protected .git" >&2; exit 1; }

"${admin_curl[@]}" "$control_url/v1/agent/sessions/$first_id/events?after=0&limit=1000" |
  jq '{schema_version:1, events:[.events[] | {cursor,attempt,source_cursor,timestamp,task_id,type,command_id,stream,pid,ok}]}' \
  >"$evidence_dir/guest-event-summary.json"
jq -e --arg id "$first_id" '.events[] | select(.task_id == $id and .type == "exec.output")' "$evidence_dir/guest-event-summary.json" >/dev/null

cross_status=$(curl --silent --output "$evidence_dir/cross-tenant-response.json" --write-out '%{http_code}' \
  --cacert "$fixture/ca.pem" --cert "$fixture/outsider.pem" --key "$fixture/outsider.key" \
  "$control_url/v1/agent/sessions/$first_id")
[[ $cross_status == 404 ]] || { echo "cross-tenant lookup returned $cross_status" >&2; exit 1; }
jq -e '.error.code == "not_found"' "$evidence_dir/cross-tenant-response.json" >/dev/null

"${admin_curl[@]}" "$control_url/v1/admin/metrics" >"$evidence_dir/metrics.json"
jq -e '.store.ready == true and .store.vm_start_attempts >= 1 and .store.tasks_by_state.succeeded >= 2 and .store.tasks_by_state.canceled >= 1' "$evidence_dir/metrics.json" >/dev/null

request_id=$(grep "operation=task_submit task_id=$first_id" "$evidence_dir/control.raw.log" | tail -1 | sed -E 's/.*request_id=([^ ]+).*/\1/')
[[ -n $request_id ]] || { echo "missing Control request correlation" >&2; exit 1; }
grep -F "request_id=$request_id" "$evidence_dir/web.raw.log" >/dev/null
grep -F "request_id=$request_id" "$evidence_dir/control.raw.log" >/dev/null
grep -F "task_id=$first_id" "$evidence_dir/control.raw.log" >/dev/null
grep -F "task_id=$first_id" "$evidence_dir/node.raw.log" >/dev/null
grep -F "task_id=$first_id" "$evidence_dir/daemon.raw.log" >/dev/null
jq -e --arg id "$first_id" '.events[] | select(.task_id == $id)' "$evidence_dir/guest-event-summary.json" >/dev/null
{
  grep -F "request_id=$request_id" "$evidence_dir/web.raw.log"
  grep -F "request_id=$request_id" "$evidence_dir/control.raw.log"
  grep -F "task_id=$first_id" "$evidence_dir/node.raw.log"
  grep -F "task_id=$first_id" "$evidence_dir/daemon.raw.log"
} >"$evidence_dir/correlation.log"

jq -n \
  --arg sha "$(git -C "$repository_root" rev-parse HEAD)" \
  --arg image_version "$active_image_version" --arg image_manifest_sha256 "$active_manifest_sha256" \
  --argjson source_dirty "$source_dirty" \
  --arg first "$first_id" --arg continuation "$continue_id" --arg canceled "$cancel_id" \
  --arg cross_tenant_status "$cross_status" \
  '{schema_version:1,status:"passed",platform:"macos",source_sha:$sha,source_dirty:$source_dirty,image:{version:$image_version,manifest_sha256:$image_manifest_sha256},tasks:{first:$first,continuation:$continuation,canceled:$canceled},cross_tenant_status:($cross_tenant_status|tonumber),protected_missing_path_cleanup:true,cleanup:"trap_registered"}' \
  >"$evidence_dir/acceptance-result.json"
chmod 600 "$evidence_dir"/*
