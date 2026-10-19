#!/bin/sh
set -eu

umask 077

[ "$(uname -s)" = Darwin ] || { echo "macOS is required" >&2; exit 1; }
[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || { echo "usage: acceptance-host-install-macos.sh IMAGE_ROOT IMAGE_PUBLIC_KEY EVIDENCE_DIR [--live]" >&2; exit 2; }

image_root=$1
image_public_key=$2
evidence_dir=$3
live=false
if [ "$#" -eq 4 ]; then
    [ "$4" = --live ] || { echo "fourth argument must be --live" >&2; exit 2; }
    live=true
fi
case "$image_root:$image_public_key:$evidence_dir" in
    *'
'*) echo "paths cannot contain newlines" >&2; exit 1 ;;
esac
case "$image_root:$image_public_key:$evidence_dir" in
    /*:/*:/*) ;;
    *) echo "all paths must be absolute" >&2; exit 1 ;;
esac
case "$evidence_dir" in
    "$HOME"/*) ;;
    *) echo "evidence directory must remain inside HOME" >&2; exit 1 ;;
esac
[ -d "$image_root" ] && [ -f "$image_public_key" ] || { echo "signed image inputs are missing" >&2; exit 1; }
[ ! -e "$evidence_dir" ] || { echo "evidence directory already exists" >&2; exit 1; }

install -d -m 700 "$evidence_dir"
fixture="$evidence_dir/fixture"
install_root="$evidence_dir/installed-host"
launch_agents="$evidence_dir/LaunchAgents"
runtime_dir="$HOME/.zapvm-installer-accept-$$"
install -d -m 700 "$fixture" "$launch_agents"
[ ! -e "$runtime_dir" ] || { echo "runtime directory already exists" >&2; exit 1; }
install -d -m 700 "$runtime_dir"

control_pid=
cleanup() {
    if [ "$live" = true ]; then
        "$PWD/scripts/zapvm-host-macos.sh" uninstall \
            --install-root "$install_root" --launch-agents "$launch_agents" \
            >/dev/null 2>&1 || true
    else
        "$PWD/scripts/zapvm-host-macos.sh" uninstall \
            --install-root "$install_root" --launch-agents "$launch_agents" --no-start \
            >/dev/null 2>&1 || true
    fi
    if [ -n "$control_pid" ]; then
        kill "$control_pid" >/dev/null 2>&1 || true
        wait "$control_pid" >/dev/null 2>&1 || true
    fi
    cleanup_runtime
}

cleanup_runtime() {
    rm -f "$runtime_dir/daemon.sock" "$runtime_dir/daemon.sock.lock"
    rmdir "$runtime_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

build_release() {
    version=$1
    output=$2
    install -d -m 700 "$output"
    go build -trimpath -ldflags "-X main.version=$version" -o "$output/zapvm" ./cmd/zapvm
    go build -trimpath -ldflags "-X main.version=$version" -o "$output/zapvm-node" ./cmd/zapvm-node
    codesign --force --sign - --entitlements packaging/macos/zapvm.entitlements "$output/zapvm" >/dev/null
    codesign --force --sign - "$output/zapvm-node" >/dev/null
}

release_one="$fixture/release-one"
release_two="$fixture/release-two"
build_release 0.1.0-installer-test.1 "$release_one"
build_release 0.1.0-installer-test.2 "$release_two"

cat >"$fixture/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ca
prompt = no
[dn]
CN = zapVM installer acceptance CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
EOF
cat >"$fixture/node.cnf" <<'EOF'
[req]
distinguished_name = dn
req_extensions = node
prompt = no
[dn]
CN = host-installer-test
[node]
subjectAltName = URI:spiffe://installer.test/node/host-installer-test
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
EOF
cat >"$fixture/node-ext.cnf" <<'EOF'
subjectAltName = URI:spiffe://installer.test/node/host-installer-test
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -config "$fixture/ca.cnf" -keyout "$fixture/ca.key" -out "$fixture/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -config "$fixture/node.cnf" \
    -keyout "$fixture/node.key" -out "$fixture/node.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "$fixture/node.csr" -CA "$fixture/ca.pem" -CAkey "$fixture/ca.key" \
    -CAcreateserial -extfile "$fixture/node-ext.cnf" -out "$fixture/node.pem" >/dev/null 2>&1
chmod 600 "$fixture/ca.key" "$fixture/node.key"

issue_certificate() {
    name=$1
    uri=$2
    usage=$3
    cat >"$fixture/$name.cnf" <<EOF
[req]
distinguished_name = dn
req_extensions = identity
prompt = no
[dn]
CN = $name
[identity]
subjectAltName = URI:$uri
keyUsage = critical,digitalSignature
extendedKeyUsage = $usage
EOF
    cat >"$fixture/$name-ext.cnf" <<EOF
subjectAltName = URI:$uri
keyUsage = critical,digitalSignature
extendedKeyUsage = $usage
EOF
    openssl req -newkey rsa:2048 -nodes -config "$fixture/$name.cnf" \
        -keyout "$fixture/$name.key" -out "$fixture/$name.csr" >/dev/null 2>&1
    openssl x509 -req -days 1 -in "$fixture/$name.csr" -CA "$fixture/ca.pem" -CAkey "$fixture/ca.key" \
        -CAserial "$fixture/ca.srl" -extfile "$fixture/$name-ext.cnf" -out "$fixture/$name.pem" >/dev/null 2>&1
    chmod 600 "$fixture/$name.key"
}

issue_certificate control spiffe://installer.test/control/primary serverAuth
issue_certificate admin spiffe://installer.test/tenant/acme/project/default/client/admin clientAuth

printf '%s\n' test-model-secret >"$fixture/model.key"
printf '%s\n' test-search-secret >"$fixture/search.key"
chmod 600 "$fixture/model.key" "$fixture/search.key"

endpoint="$runtime_dir/daemon.sock"
state_root="$evidence_dir/state"
control_port=19444
if [ "$live" = true ] && /usr/sbin/lsof -nP -iTCP:"$control_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "acceptance control port $control_port is already in use" >&2
    exit 1
fi
cat >"$fixture/daemon.json" <<EOF
{
  "schema_version": 1,
  "endpoint": "$endpoint",
  "image_root": "$image_root",
  "image_public_key": "$image_public_key",
  "state_root": "$state_root",
  "max_workers": 2,
  "max_per_workspace": 1,
  "credentials": [
    {"id":"model-api-key","path":"$fixture/model.key"},
    {"id":"search-api-key","path":"$fixture/search.key"}
  ]
}
EOF
cat >"$fixture/cloud-node.json" <<EOF
{
  "schema_version": 1,
  "control_url": "https://127.0.0.1:$control_port",
  "trust_domain": "installer.test",
  "control_id": "primary",
  "node_id": "host-installer-test",
  "server_ca": "$fixture/ca.pem",
  "certificate": "$fixture/node.pem",
  "private_key": "$fixture/node.key",
  "daemon_endpoint": "$endpoint",
  "workspace_root": "$fixture/workspaces",
  "poll_ms": 250,
  "max_concurrent": 2
}
EOF
chmod 600 "$fixture/daemon.json" "$fixture/cloud-node.json"

if [ "$live" = true ]; then
    go build -trimpath -ldflags "-X main.version=0.1.0-installer-test.control" -o "$fixture/zapvm-control" ./cmd/zapvm-control
    cat >"$fixture/cloud-control.json" <<EOF
{
  "schema_version": 1,
  "listen": "127.0.0.1:$control_port",
  "state_root": "$evidence_dir/control-state",
  "trust_domain": "installer.test",
  "control_id": "primary",
  "client_ca": "$fixture/ca.pem",
  "certificate": "$fixture/control.pem",
  "private_key": "$fixture/control.key",
  "heartbeat_ttl_seconds": 10,
  "lease_ttl_seconds": 30,
  "administrators": ["spiffe://installer.test/tenant/acme/project/default/client/admin"],
  "nodes": [{
    "id": "host-installer-test",
    "capacity": 2,
    "scopes": [{"tenant_id":"acme","project_id":"default"}],
    "computers": [{"id":"computer-installer-test","tenant_id":"acme","project_id":"default"}]
  }]
}
EOF
    chmod 600 "$fixture/cloud-control.json"
    "$fixture/zapvm-control" --config "$fixture/cloud-control.json" --validate >"$evidence_dir/control-validate.log"
    "$fixture/zapvm-control" --config "$fixture/cloud-control.json" >"$evidence_dir/control.log" 2>&1 &
    control_pid=$!
    sleep 1
    kill -0 "$control_pid"
fi

installer="$PWD/scripts/zapvm-host-macos.sh"

run_install_action() {
    action=$1
    source=$2
    output=$3
    if [ "$live" = true ]; then
        "$installer" "$action" --source-dir "$source" --daemon-config "$fixture/daemon.json" --node-config "$fixture/cloud-node.json" \
            --install-root "$install_root" --launch-agents "$launch_agents" >"$output"
    else
        "$installer" "$action" --source-dir "$source" --daemon-config "$fixture/daemon.json" --node-config "$fixture/cloud-node.json" \
            --install-root "$install_root" --launch-agents "$launch_agents" --no-start >"$output"
    fi
}

run_simple_action() {
    action=$1
    output=$2
    if [ "$live" = true ]; then
        "$installer" "$action" --install-root "$install_root" --launch-agents "$launch_agents" >"$output"
    else
        "$installer" "$action" --install-root "$install_root" --launch-agents "$launch_agents" --no-start >"$output"
    fi
}

wait_for_node_version() {
    expected=$1
    [ "$live" = true ] || return 0
    deadline=$(( $(date +%s) + 20 ))
    while ! grep -Fq "\"node_version\":\"$expected\"" "$evidence_dir/control-state/state.json" 2>/dev/null ||
        ! grep -Fq '"daemon_state":"healthy"' "$evidence_dir/control-state/state.json" 2>/dev/null; do
        [ "$(date +%s)" -lt "$deadline" ] || { echo "Node did not register healthy version $expected" >&2; return 1; }
        sleep 1
    done
}

run_install_action install "$release_one" "$evidence_dir/install.log"
cat "$evidence_dir/install.log"
wait_for_node_version 0.1.0-installer-test.1
run_simple_action doctor "$evidence_dir/doctor-install.log"
cat "$evidence_dir/doctor-install.log"
[ "$(readlink "$install_root/current")" = releases/0.1.0-installer-test.1 ]
[ "$(stat -f '%Lp' "$install_root/config/daemon.json")" = 600 ]
plutil -lint "$launch_agents/com.zapvm.daemon.plist" "$launch_agents/com.zapvm.node.plist" >"$evidence_dir/plist-lint.log"
! grep -Eq '/bin/(ba)?sh|EnvironmentVariables' "$launch_agents"/*.plist

run_install_action upgrade "$release_two" "$evidence_dir/upgrade.log"
cat "$evidence_dir/upgrade.log"
wait_for_node_version 0.1.0-installer-test.2
[ "$(readlink "$install_root/current")" = releases/0.1.0-installer-test.2 ]
[ "$(readlink "$install_root/previous")" = releases/0.1.0-installer-test.1 ]

run_simple_action rollback "$evidence_dir/rollback.log"
cat "$evidence_dir/rollback.log"
wait_for_node_version 0.1.0-installer-test.1
[ "$(readlink "$install_root/current")" = releases/0.1.0-installer-test.1 ]
[ "$(readlink "$install_root/previous")" = releases/0.1.0-installer-test.2 ]

run_simple_action uninstall "$evidence_dir/uninstall.log"
cat "$evidence_dir/uninstall.log"
[ ! -e "$install_root/current" ] && [ ! -e "$install_root/previous" ]
[ ! -e "$launch_agents/com.zapvm.daemon.plist" ] && [ ! -e "$launch_agents/com.zapvm.node.plist" ]
[ -d "$install_root/releases" ] && [ -f "$install_root/config/daemon.json" ]

trap - EXIT HUP INT TERM
if [ -n "$control_pid" ]; then
    kill "$control_pid"
    wait "$control_pid" || true
    control_pid=
fi
cleanup_runtime
printf '%s\n' "MACOS_HOST_INSTALL_ACCEPTANCE_OK evidence=$evidence_dir"
