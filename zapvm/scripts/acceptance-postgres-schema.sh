#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || {
    printf '%s\n' 'acceptance-postgres-schema: docker is required' >&2
    exit 1
}

container="zapvm-postgres-schema-$$"
password="zapvm-schema-$$"

cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker run --detach --rm \
    --name "$container" \
    --publish 127.0.0.1::5432 \
    --env POSTGRES_DB=zapvm \
    --env POSTGRES_USER=zapvm \
    --env "POSTGRES_PASSWORD=$password" \
    postgres:16-alpine >/dev/null

attempt=0
until docker exec "$container" pg_isready --username zapvm --dbname zapvm >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
        printf '%s\n' 'acceptance-postgres-schema: PostgreSQL did not become ready' >&2
        exit 1
    fi
    sleep 1
done

port=$(docker port "$container" 5432/tcp | awk -F: 'NR == 1 {print $NF}')
case "$port" in
    ''|*[!0-9]*)
        printf '%s\n' 'acceptance-postgres-schema: Docker returned an invalid PostgreSQL port' >&2
        exit 1
        ;;
esac

ZAPVM_TEST_POSTGRES_DSN="postgres://zapvm:$password@127.0.0.1:$port/zapvm?sslmode=disable" \
    go test ./internal/controlpostgres -run '^TestPostgreSQLSchemaIntegration$' -count=1 -v

ZAPVM_TEST_POSTGRES_CONTAINER="$container" ZAPVM_TEST_POSTGRES_DSN="postgres://zapvm:$password@127.0.0.1:$port/zapvm?sslmode=disable" \
    go test ./internal/controlpostgres -run '^(TestPostgreSQL(DistributedQueue|BackendMultiReplicaEventRecovery|BackendReconcilesTrackedLegacyComputers|QueueCapacityTimeoutAndComputerRuntime|DynamicPlacementCompetitionAndGenerationFence|IdleStoppedComputerReleasesPlacement)Integration|TestPostgreSQLSweepPrioritizesExpiredPendingTasks)$' -count=1 -v

ZAPVM_TEST_POSTGRES_DSN="postgres://zapvm:$password@127.0.0.1:$port/zapvm?sslmode=disable" \
    go test ./internal/controlpostgres -run '^TestPostgreSQLComputerAdminLifecycleIntegration$' -count=1 -v

ZAPVM_TEST_POSTGRES_DSN="postgres://zapvm:$password@127.0.0.1:$port/zapvm?sslmode=disable" \
    go test ./internal/controlpostgres -run '^TestPostgreSQLPlatformAdminFoundationIntegration$' -count=1 -v

ZAPVM_TEST_POSTGRES_DSN="postgres://zapvm:$password@127.0.0.1:$port/zapvm?sslmode=disable" \
    go test ./cmd/zapvm-control-db -run TestFileImportCLIIntegration -count=1 -v

ZAPVM_TEST_POSTGRES_DSN="postgres://zapvm:$password@127.0.0.1:$port/zapvm?sslmode=disable" \
    go test ./cmd/zapvm-control -run 'TestOpenPostgreSQL(Mirror|Primary)' -count=1 -v

status=$(ZAPVM_POSTGRES_DSN="postgres://zapvm:$password@127.0.0.1:$port/zapvm?sslmode=disable" \
    go run ./cmd/zapvm-control-db --development-insecure-localhost status)
printf '%s' "$status" | grep -Eq '"current"[[:space:]]*:[[:space:]]*14' || {
	printf '%s\n' 'acceptance-postgres-schema: migration CLI did not report schema version 14' >&2
	exit 1
}

printf '%s\n' 'POSTGRES_SCHEMA_ACCEPTANCE_OK version=14 postgres=16 platform_admin=verified credential_ledger=verified online_mirror=verified primary_cutover=verified file_rollback=verified distributed_queue=verified multi_replica_backend=verified legacy_computers=verified computer_runtime=verified queue_deadline=verified dynamic_placement=verified computer_start=verified computer_stop=verified idle_reclamation=verified replica_termination=verified rolling_replacement=verified database_partition_recovery=verified event_recovery=verified node_generation=verified sessions=verified artifacts=verified workspace=verified git_operations=verified audit_chain=verified cancellation=verified'
