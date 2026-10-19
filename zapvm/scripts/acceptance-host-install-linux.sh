#!/bin/sh
set -eu

umask 077

[ "$(uname -s)" = Linux ] || { echo "Linux is required" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "acceptance must run as the dedicated non-root Host user" >&2; exit 1; }
[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || { echo "usage: acceptance-host-install-linux.sh IMAGE_ROOT IMAGE_PUBLIC_KEY EVIDENCE_DIR [--live]" >&2; exit 2; }

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
case "$image_root:$image_public_key:$evidence_dir" in /*:/*:/*) ;; *) echo "all paths must be absolute" >&2; exit 1 ;; esac
case "$evidence_dir" in "$HOME"/*) ;; *) echo "evidence directory must remain inside HOME" >&2; exit 1 ;; esac
[ -d "$image_root" ] && [ -f "$image_public_key" ] || { echo "signed image inputs are missing" >&2; exit 1; }
[ ! -e "$evidence_dir" ] || { echo "evidence directory already exists" >&2; exit 1; }

install -d -m 700 "$evidence_dir"
fixture="$evidence_dir/fixture"
install_root="$evidence_dir/installed-host"
offline_unit_dir="$evidence_dir/systemd-user"
runtime_dir="$HOME/.zapvm-installer-accept-$$"
default_unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if [ "$live" = true ]; then
    unit_dir=$default_unit_dir
    for unit in zapvm-daemon.service zapvm-node.service; do
        [ ! -e "$unit_dir/$unit" ] || { echo "refusing to replace existing $unit_dir/$unit" >&2; exit 1; }
    done
else
    unit_dir=$offline_unit_dir
fi
install -d -m 700 "$fixture"
if [ ! -d "$unit_dir" ]; then
    install -d -m 700 "$unit_dir"
fi
[ ! -e "$runtime_dir" ] || { echo "runtime directory already exists" >&2; exit 1; }
install -d -m 700 "$runtime_dir"

control_pid=
installer="$PWD/scripts/zapvm-host-linux.sh"
cleanup_runtime() {
    rm -f "$runtime_dir/daemon.sock" "$runtime_dir/daemon.sock.lock"
    rmdir "$runtime_dir" 2>/dev/null || true
}
cleanup() {
    if [ -d "$install_root" ]; then
        if [ "$live" = true ]; then
            "$installer" uninstall --install-root "$install_root" --unit-dir "$unit_dir" >/dev/null 2>&1 || true
        else
            "$installer" uninstall --install-root "$install_root" --unit-dir "$unit_dir" --no-start >/dev/null 2>&1 || true
        fi
    fi
    if [ -n "$control_pid" ]; then
        kill "$control_pid" >/dev/null 2>&1 || true
        wait "$control_pid" >/dev/null 2>&1 || true
    fi
    cleanup_runtime
}
trap cleanup EXIT HUP INT TERM

openssl genpkey -algorithm ED25519 -out "$fixture/release-private.pem" >/dev/null 2>&1
openssl pkey -in "$fixture/release-private.pem" -pubout -out "$fixture/release-public.pem" >/dev/null 2>&1
chmod 600 "$fixture/release-private.pem" "$fixture/release-public.pem"

build_release() {
    version=$1
    output=$2
    install -d -m 700 "$output"
    go build -trimpath -ldflags "-X main.version=$version" -o "$output/zapvm" ./cmd/zapvm
    go build -trimpath -ldflags "-X main.version=$version" -o "$output/zapvm-node" ./cmd/zapvm-node
    (cd "$output" && sha256sum zapvm zapvm-node >SHA256SUMS)
    openssl pkeyutl -sign -rawin -inkey "$fixture/release-private.pem" \
        -in "$output/SHA256SUMS" -out "$output/SHA256SUMS.sig"
    chmod 600 "$output/SHA256SUMS" "$output/SHA256SUMS.sig"
}

release_one="$fixture/release-one"
release_two="$fixture/release-two"
build_release 0.1.0-installer-test.1 "$release_one"
build_release 0.1.0-installer-test.2 "$release_two"
fault_release="$fixture/release-fault"
if [ "$live" = true ]; then
    install -d -m 700 "$fault_release"
    go build -trimpath -ldflags "-X main.version=0.1.0-installer-test.fault" -o "$fault_release/zapvm" ./cmd/zapvm
    go build -trimpath -ldflags "-X main.version=0.1.0-installer-test.fault" -o "$fault_release/zapvm-node.real" ./cmd/zapvm-node
    cat >"$fault_release/zapvm-node" <<EOF
#!/bin/sh
for argument in "\$@"; do
    case "\$argument" in
        --version|--validate|--print-daemon-endpoint) exec "$fault_release/zapvm-node.real" "\$@" ;;
    esac
done
exit 42
EOF
    chmod 755 "$fault_release/zapvm-node"
    (cd "$fault_release" && sha256sum zapvm zapvm-node >SHA256SUMS)
    openssl pkeyutl -sign -rawin -inkey "$fixture/release-private.pem" \
        -in "$fault_release/SHA256SUMS" -out "$fault_release/SHA256SUMS.sig"
    chmod 600 "$fault_release/SHA256SUMS" "$fault_release/SHA256SUMS.sig"
fi

cat >"$fixture/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ca
prompt = no
[dn]
CN = zapVM Linux installer acceptance CA
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
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$fixture/ca.cnf" \
    -keyout "$fixture/ca.key" -out "$fixture/ca.pem" >/dev/null 2>&1
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
control_port=${ZAPVM_ACCEPTANCE_CONTROL_PORT:-19444}
case "$control_port" in ''|*[!0-9]*) echo "invalid ZAPVM_ACCEPTANCE_CONTROL_PORT" >&2; exit 1 ;; esac
if [ "$live" = true ] && command -v ss >/dev/null 2>&1 && ss -ltn | grep -Eq "[.:]${control_port}[[:space:]]"; then
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

run_install_action() {
    action=$1
    source=$2
    output=$3
    if [ "$live" = true ]; then
        "$installer" "$action" --source-dir "$source" --release-public-key "$fixture/release-public.pem" \
            --daemon-config "$fixture/daemon.json" --node-config "$fixture/cloud-node.json" \
            --install-root "$install_root" --unit-dir "$unit_dir" >"$output"
    else
        "$installer" "$action" --source-dir "$source" --release-public-key "$fixture/release-public.pem" \
            --daemon-config "$fixture/daemon.json" --node-config "$fixture/cloud-node.json" \
            --install-root "$install_root" --unit-dir "$unit_dir" --no-start >"$output"
    fi
}

run_simple_action() {
    action=$1
    output=$2
    if [ "$live" = true ]; then
        "$installer" "$action" --install-root "$install_root" --unit-dir "$unit_dir" >"$output"
    else
        "$installer" "$action" --install-root "$install_root" --unit-dir "$unit_dir" --no-start >"$output"
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
[ "$(stat -c '%a' "$install_root/config/daemon.json")" = 600 ]
if grep -Eq '/bin/(ba)?sh|Environment=|EnvironmentFile=' "$unit_dir"/zapvm-*.service; then
    echo "generated systemd units contain forbidden shell or environment authority" >&2
    exit 1
fi

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

if [ "$live" = true ]; then
    if "$installer" upgrade --source-dir "$fault_release" --release-public-key "$fixture/release-public.pem" \
        --daemon-config "$fixture/daemon.json" --node-config "$fixture/cloud-node.json" \
        --install-root "$install_root" --unit-dir "$unit_dir" >"$evidence_dir/failed-upgrade.log" 2>&1; then
        echo "faulting Node upgrade unexpectedly succeeded" >&2
        exit 1
    fi
    grep -F "previous release was restored" "$evidence_dir/failed-upgrade.log" >/dev/null
    wait_for_node_version 0.1.0-installer-test.1
    [ "$(readlink "$install_root/current")" = releases/0.1.0-installer-test.1 ]
    [ "$(readlink "$install_root/previous")" = releases/0.1.0-installer-test.2 ]
fi

if [ "$live" = true ]; then
    journalctl --user-unit zapvm-daemon.service --user-unit zapvm-node.service --no-pager -n 500 >"$evidence_dir/service-journal.log" 2>&1 || true
fi
run_simple_action uninstall "$evidence_dir/uninstall.log"
cat "$evidence_dir/uninstall.log"
[ ! -e "$install_root/current" ] && [ ! -e "$install_root/previous" ]
[ ! -e "$unit_dir/zapvm-daemon.service" ] && [ ! -e "$unit_dir/zapvm-node.service" ]
[ -d "$install_root/releases" ] && [ -f "$install_root/config/daemon.json" ]

trap - EXIT HUP INT TERM
if [ -n "$control_pid" ]; then
    kill "$control_pid"
    wait "$control_pid" || true
    control_pid=
fi
cleanup_runtime
printf '%s\n' "LINUX_HOST_INSTALL_ACCEPTANCE_OK evidence=$evidence_dir"
