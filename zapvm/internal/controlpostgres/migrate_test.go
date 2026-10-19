package controlpostgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"zapvm/internal/cloudplane"
	"zapvm/internal/credentialkms"
	"zapvm/internal/daemonrpc"
)

func TestEmbeddedMigrationsAreContiguousBoundedAndNonDestructive(t *testing.T) {
	migrations, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrations) != 14 || migrations[0].Version != 1 || migrations[0].Name != "initial" || migrations[1].Version != 2 || migrations[1].Name != "file_snapshot_import" || migrations[2].Version != 3 || migrations[2].Name != "primary_state" || migrations[3].Version != 4 || migrations[3].Name != "distributed_queue" || migrations[4].Version != 5 || migrations[4].Name != "artifact_runtime" || migrations[5].Version != 6 || migrations[5].Name != "workspace_result_raw" || migrations[6].Version != 7 || migrations[6].Name != "credential_ledger" || migrations[7].Version != 8 || migrations[7].Name != "node_identity" || migrations[8].Version != 9 || migrations[8].Name != "computer_agent" || migrations[9].Version != 10 || migrations[9].Name != "computer_runtime" || migrations[10].Version != 11 || migrations[10].Name != "dynamic_placement" || migrations[11].Version != 12 || migrations[11].Name != "computer_start_operations" || migrations[12].Version != 13 || migrations[12].Name != "computer_stop_operations" || migrations[13].Version != 14 || migrations[13].Name != "platform_admin" {
		t.Fatalf("migrations=%#v", migrations)
	}
	var migrationSQL []string
	for _, migration := range migrations {
		migrationSQL = append(migrationSQL, migration.SQL)
	}
	combined := strings.Join(migrationSQL, "\n")
	upper := strings.ToUpper(combined)
	for _, forbidden := range []string{"DROP TABLE", "DROP SCHEMA", "TRUNCATE ", "DELETE FROM"} {
		if strings.Contains(upper, forbidden) {
			t.Fatalf("migration set contains destructive statement %q", forbidden)
		}
	}
	for _, required := range []string{
		"zapvm.nodes", "zapvm.node_scopes", "zapvm.computers", "zapvm.agent_sessions", "zapvm.tasks",
		"zapvm.task_events", "zapvm.task_transition_receipts", "zapvm.task_outbox", "zapvm.workspace_operations", "zapvm.artifacts", "zapvm.audit_records", "zapvm.computer_nodes", "zapvm.computer_runtime", "zapvm.computer_placements", "zapvm.computer_operations", "zapvm.node_resources", "zapvm.file_mirror_state", "zapvm.primary_state", "zapvm.credential_envelopes", "zapvm.credential_capabilities", "zapvm.credential_capability_items", "zapvm.credential_access_audit", "zapvm.node_enrollment_tokens", "zapvm.node_certificates", "zapvm.node_identity_audit", "zapvm.workspace_members", "zapvm.host_pools", "zapvm.host_pool_nodes", "zapvm.model_profiles", "zapvm.agent_profiles", "zapvm.computer_profiles", "zapvm.workspace_quotas", "payload_raw", "queue_reason", "queue_deadline", "placement_epoch", "provisioning_source",
		"FORCE ROW LEVEL SECURITY", "lease_token_hash", "DEFERRABLE INITIALLY DEFERRED",
	} {
		if !strings.Contains(combined, required) {
			t.Fatalf("migration set is missing %q", required)
		}
	}
}

func TestDSNRequiresPostgreSQLURLAndTLSOutsideLocalDevelopment(t *testing.T) {
	for _, value := range []string{"", "mysql://localhost/db", "postgres:///missing-host", "postgres://db.example/test#fragment"} {
		if validateDSN(value) == nil {
			t.Fatalf("invalid DSN accepted: %q", value)
		}
	}
	ctx := context.Background()
	if _, err := Open(ctx, "postgres://user:password@127.0.0.1:1/test?sslmode=disable", OpenOptions{}); err == nil || !strings.Contains(err.Error(), "TLS is required") {
		t.Fatalf("insecure production DSN error=%v", err)
	}
}

func TestPostgreSQLSchemaIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	connection, err := migrator.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, bootstrapSQL); err != nil {
		t.Fatal(err)
	}
	if err := applyMigration(ctx, connection, migrator.migrations[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec(ctx, `SELECT set_config('zapvm.bypass_rls', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO zapvm.nodes (id, generation, state, capacity, last_heartbeat, daemon_state) VALUES ('node-upgrade', 'generation-00001', 'offline', 1, clock_timestamp(), 'unknown')`,
		`INSERT INTO zapvm.node_scopes (node_id, tenant_id, project_id) VALUES ('node-upgrade', 'acme', 'upgrade')`,
		`INSERT INTO zapvm.computers (tenant_id, project_id, computer_id, node_id) VALUES ('acme', 'upgrade', 'computer-upgrade', 'node-upgrade')`,
	} {
		if _, err := connection.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := applyMigration(ctx, connection, migrator.migrations[1]); err != nil {
		t.Fatal(err)
	}
	var transferred int
	if err := connection.QueryRow(ctx, `SELECT count(*) FROM zapvm.computer_nodes WHERE tenant_id = 'acme' AND project_id = 'upgrade' AND computer_id = 'computer-upgrade' AND node_id = 'node-upgrade'`).Scan(&transferred); err != nil || transferred != 1 {
		t.Fatalf("Computer migration transfer count=%d err=%v", transferred, err)
	}
	for _, statement := range []string{
		`DELETE FROM zapvm.computer_nodes`, `DELETE FROM zapvm.computers`, `DELETE FROM zapvm.node_scopes`, `DELETE FROM zapvm.nodes`,
	} {
		if _, err := connection.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := connection.Exec(ctx, `RESET zapvm.bypass_rls`); err != nil {
		t.Fatal(err)
	}
	for pass := 0; pass < 2; pass++ {
		status, err := migrator.Apply(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if status.Current != 14 || status.Pending != 0 || len(status.Applied) != 14 {
			t.Fatalf("pass=%d status=%#v", pass, status)
		}
	}
	var tables []string
	rows, err := connection.Query(ctx, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'zapvm' ORDER BY table_name`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, table)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"agent_profiles", "agent_sessions", "artifacts", "audit_records", "computer_nodes", "computer_operations", "computer_placements", "computer_profiles", "computer_runtime", "computers", "control_state", "credential_access_audit", "credential_capabilities", "credential_capability_items", "credential_envelopes", "file_mirror_state", "host_pool_nodes", "host_pools", "model_profiles", "node_certificates", "node_enrollment_tokens", "node_identity_audit", "node_resources", "node_scopes", "nodes", "primary_state", "schema_migrations", "scope_dispatch", "task_events", "task_outbox", "task_transition_receipts", "tasks", "workspace_members", "workspace_operations", "workspace_quotas"} {
		if !contains(tables, required) {
			t.Fatalf("tables=%v missing=%s", tables, required)
		}
	}
	tenantTables := []string{"agent_profiles", "agent_sessions", "artifacts", "audit_records", "computer_nodes", "computer_operations", "computer_placements", "computer_profiles", "computer_runtime", "computers", "credential_access_audit", "credential_capabilities", "credential_capability_items", "credential_envelopes", "host_pool_nodes", "host_pools", "model_profiles", "node_scopes", "scope_dispatch", "task_events", "task_outbox", "task_transition_receipts", "tasks", "workspace_members", "workspace_operations", "workspace_quotas"}
	rows, err = connection.Query(ctx, `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'zapvm'::regnamespace AND relname = ANY($1) ORDER BY relname`, tenantTables)
	if err != nil {
		t.Fatal(err)
	}
	var securedTables []string
	for rows.Next() {
		var table string
		var enabled bool
		var forced bool
		if err := rows.Scan(&table, &enabled, &forced); err != nil {
			t.Fatal(err)
		}
		if !enabled || !forced {
			t.Fatalf("table %s RLS enabled=%t forced=%t", table, enabled, forced)
		}
		securedTables = append(securedTables, table)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(securedTables) != len(tenantTables) {
		t.Fatalf("RLS tables=%v expected=%v", securedTables, tenantTables)
	}
	testCredentialLedgerConstraints(t, ctx, connection)
	transaction, err := connection.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls', 'on', true)`); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO zapvm.nodes (id, generation, state, capacity, last_heartbeat, daemon_state) VALUES ('node-a', 'generation-00001', 'online', 4, clock_timestamp(), 'healthy')`,
		`INSERT INTO zapvm.node_scopes (node_id, tenant_id, project_id) VALUES ('node-a', 'acme', 'default'), ('node-a', 'beta', 'build')`,
		`INSERT INTO zapvm.computers (tenant_id, project_id, computer_id) VALUES ('acme', 'default', 'computer-a'), ('beta', 'build', 'computer-b')`,
		`INSERT INTO zapvm.computer_nodes (tenant_id, project_id, computer_id, node_id) VALUES ('acme', 'default', 'computer-a', 'node-a'), ('beta', 'build', 'computer-b', 'node-a')`,
		`INSERT INTO zapvm.agent_sessions (tenant_id, project_id, session_id, computer_id, created_at, updated_at) VALUES ('acme', 'default', 'session-a', 'computer-a', clock_timestamp(), clock_timestamp())`,
		`INSERT INTO zapvm.tasks (id, tenant_id, project_id, computer_id, session_id, payload, payload_sha256, state, created_at, created_sequence, updated_at) VALUES ('task-a', 'acme', 'default', 'computer-a', 'session-a', '{}', decode(repeat('01', 32), 'hex'), 'pending', clock_timestamp(), 1, clock_timestamp())`,
		`INSERT INTO zapvm.scope_dispatch (tenant_id, project_id, dispatch_cursor) VALUES ('acme', 'default', 1), ('beta', 'build', 2)`,
		`INSERT INTO zapvm.task_events (tenant_id, project_id, task_id, cursor, attempt, source_cursor, occurred_at, type, data) VALUES ('acme', 'default', 'task-a', 1, 1, 1, clock_timestamp(), 'command.stdout', decode('6f6b', 'hex'))`,
		`INSERT INTO zapvm.workspace_operations (id, tenant_id, project_id, computer_id, kind, path, state, created_at, updated_at, expires_at, created_sequence) VALUES ('operation-a', 'acme', 'default', 'computer-a', 'list', '', 'pending', transaction_timestamp(), transaction_timestamp(), transaction_timestamp() + interval '15 minutes', 2)`,
		`INSERT INTO zapvm.artifacts (id, tenant_id, project_id, computer_id, session_id, task_id, path, name, content_type, size_bytes, sha256, state, retention_seconds, created_at, updated_at, expires_at, created_sequence, registered_node_id, registered_node_generation) VALUES ('artifact-a', 'acme', 'default', 'computer-a', 'session-a', 'task-a', 'outputs/result.txt', 'result.txt', 'text/plain', 2, decode(repeat('03', 32), 'hex'), 'pending', 3600, transaction_timestamp(), transaction_timestamp(), transaction_timestamp() + interval '1 hour', 3, 'node-a', 'generation-00001')`,
		`UPDATE zapvm.artifacts SET state = 'available', object_key = 'v1/acme/artifact-a/hash', available_at = transaction_timestamp(), updated_at = transaction_timestamp() WHERE id = 'artifact-a'`,
		`UPDATE zapvm.artifacts SET state = 'expired', updated_at = transaction_timestamp() WHERE id = 'artifact-a'`,
		`INSERT INTO zapvm.audit_records (sequence, schema_version, occurred_at, action, tenant_id, project_id, task_id, outcome, sha256) VALUES (1, 1, clock_timestamp(), 'task_submit', 'acme', 'default', 'task-a', 'created', decode(repeat('04', 32), 'hex'))`,
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement); err != nil {
			t.Fatalf("statement failed: %s: %v", statement, err)
		}
	}
	if _, err := transaction.Exec(ctx, `SAVEPOINT invalid_lease`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.tasks (id, tenant_id, project_id, computer_id, payload, payload_sha256, state, created_at, created_sequence, updated_at) VALUES ('task-invalid-lease', 'acme', 'default', 'computer-a', '{}', decode(repeat('02', 32), 'hex'), 'running', clock_timestamp(), 4, clock_timestamp())`); err == nil {
		t.Fatal("active Task without lease authority passed database constraints")
	}
	if _, err := transaction.Exec(ctx, `ROLLBACK TO SAVEPOINT invalid_lease`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `SAVEPOINT invalid_scope`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.workspace_operations (id, tenant_id, project_id, computer_id, kind, task_id, provider_id, branch, state, created_at, updated_at, expires_at, created_sequence) VALUES ('cross-scope', 'beta', 'build', 'computer-b', 'git_push', 'task-a', 'github', 'zapvm/cross-scope', 'pending', transaction_timestamp(), transaction_timestamp(), transaction_timestamp() + interval '15 minutes', 5)`); err == nil {
		t.Fatal("workspace operation accepted a cross-tenant Task reference")
	}
	if _, err := transaction.Exec(ctx, `ROLLBACK TO SAVEPOINT invalid_scope`); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	transaction, err = connection.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls', 'on', true)`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{statements[0], statements[1], statements[2], statements[3], statements[6]} {
		if _, err := transaction.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := transaction.Exec(ctx, `CREATE ROLE zapvm_rls_probe NOLOGIN`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `GRANT USAGE ON SCHEMA zapvm TO zapvm_rls_probe; GRANT SELECT ON zapvm.scope_dispatch TO zapvm_rls_probe`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `SET LOCAL ROLE zapvm_rls_probe`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls', 'on', true), set_config('zapvm.tenant_id', 'acme', true), set_config('zapvm.project_id', 'default', true)`); err != nil {
		t.Fatal(err)
	}
	var visible int
	if err := transaction.QueryRow(ctx, `SELECT count(*) FROM zapvm.scope_dispatch`).Scan(&visible); err != nil || visible != 1 {
		t.Fatalf("tenant RLS or owner-gated bypass visible=%d err=%v", visible, err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.scope_dispatch (tenant_id, project_id, dispatch_cursor) VALUES ('beta', 'build', 3)`); err == nil {
		t.Fatal("tenant RLS allowed a cross-tenant insert")
	}
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	checksum := make([]byte, 32)
	if err := connection.QueryRow(ctx, `SELECT checksum FROM zapvm.schema_migrations WHERE version = 1`).Scan(&checksum); err != nil {
		t.Fatal(err)
	}
	if len(checksum) != 32 || hex.EncodeToString(checksum) != migratorChecksum(t, migrator, 0) {
		t.Fatal("persisted migration checksum differs from embedded migration")
	}
	if _, err := connection.Exec(ctx, `UPDATE zapvm.schema_migrations SET checksum = decode(repeat('00', 32), 'hex') WHERE version = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.Apply(ctx); err == nil || !strings.Contains(err.Error(), "differs from the binary") {
		t.Fatalf("migration checksum drift error=%v", err)
	}
	if _, err := connection.Exec(ctx, `UPDATE zapvm.schema_migrations SET checksum = $1 WHERE version = 1`, checksum); err != nil {
		t.Fatal(err)
	}

	snapshot := controlFileSnapshot(t)
	if _, err := connection.Exec(ctx, `INSERT INTO zapvm.nodes (id, generation, state, capacity, last_heartbeat, daemon_state) VALUES ('untracked-node', 'generation-00001', 'offline', 1, clock_timestamp(), 'unknown')`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.ImportFileSnapshot(ctx, snapshot, FileImportOptions{}); err == nil || !strings.Contains(err.Error(), "untracked") {
		t.Fatalf("untracked database import error=%v", err)
	}
	report, err := migrator.ImportFileSnapshot(ctx, snapshot, FileImportOptions{ReplaceUntracked: true})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Changed || report.SnapshotFormat != cloudplane.OfflineSnapshotFormatVersion || report.RowCounts["nodes"] != 1 || report.RowCounts["tasks"] != 1 || report.RowCounts["task_events"] != 1 || report.RowCounts["audit_records"] < 5 {
		t.Fatalf("first import report=%#v", report)
	}
	repeated, err := migrator.ImportFileSnapshot(ctx, snapshot, FileImportOptions{})
	if err != nil || repeated.Changed || repeated.SourceSHA256 != report.SourceSHA256 || repeated.DatabaseSHA256 != report.DatabaseSHA256 {
		t.Fatalf("idempotent import report=%#v err=%v", repeated, err)
	}
	verified, err := migrator.VerifyFileSnapshot(ctx, snapshot)
	if err != nil || verified.DatabaseSHA256 != report.DatabaseSHA256 {
		t.Fatalf("verify report=%#v err=%v", verified, err)
	}
	if _, err := connection.Exec(ctx, `UPDATE zapvm.tasks SET updated_at = updated_at + interval '1 second' WHERE id = 'task-import'`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.VerifyFileSnapshot(ctx, snapshot); err == nil || !strings.Contains(err.Error(), "drift") {
		t.Fatalf("database drift verification error=%v", err)
	}
	if _, err := migrator.ImportFileSnapshot(ctx, snapshot, FileImportOptions{}); err == nil || !strings.Contains(err.Error(), "repair") {
		t.Fatalf("database drift import error=%v", err)
	}
	repaired, err := migrator.ImportFileSnapshot(ctx, snapshot, FileImportOptions{RepairDrift: true})
	if err != nil || !repaired.Changed {
		t.Fatalf("repair report=%#v err=%v", repaired, err)
	}
	if _, err := migrator.VerifyFileSnapshot(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	mutated := snapshot
	var mutatedState snapshotState
	if err := json.Unmarshal(mutated.StateJSON, &mutatedState); err != nil {
		t.Fatal(err)
	}
	secret := "private-import-payload-must-not-leak"
	task := mutatedState.Tasks["task-import"]
	task.State = cloudplane.TaskRunning
	task.Payload = bytes.Replace(task.Payload, []byte(`"ok"`), []byte(`"`+secret+`"`), 1)
	payloadDigest := sha256.Sum256(task.Payload)
	task.PayloadSHA256 = hex.EncodeToString(payloadDigest[:])
	mutatedState.Tasks[task.ID] = task
	mutated.StateJSON, err = json.Marshal(mutatedState)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.ImportFileSnapshot(ctx, mutated, FileImportOptions{}); err == nil || strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), "PostgreSQL code") {
		t.Fatalf("redacted transactional import error=%v", err)
	}
	if _, err := migrator.VerifyFileSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("failed import changed the committed mirror: %v", err)
	}

	// Exercise the online GA-01b-2 path against the same real PostgreSQL 16
	// instance. Store.Open must reconcile before serving, every durable file
	// mutation is mirrored asynchronously, and Store.Close must not return
	// until the latest snapshot is transactionally visible in PostgreSQL.
	onlineMirror, err := NewOnlineMirror(migrator, OnlineMirrorOptions{RetryInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	onlineRoot := t.TempDir()
	onlineProvisions := []cloudplane.NodeProvision{{
		ID: "node-online", Capacity: 2,
		Scopes:    []cloudplane.Scope{{TenantID: "acme", ProjectID: "online"}},
		Computers: []cloudplane.ComputerProvision{{ID: "computer-online", TenantID: "acme", ProjectID: "online"}},
	}}
	onlineStore, err := cloudplane.Open(onlineRoot, onlineProvisions, cloudplane.Options{
		StateMirror: onlineMirror, StateMirrorTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := onlineStore.RegisterNode("node-online", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	onlinePayload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-online", ComputerID: "computer-online",
		Command: daemonrpc.Command{ID: "command-online", SessionID: "session-online", Argv: []string{"echo", "online"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := onlineStore.Submit("spiffe://example.test/tenant/acme/project/online/client/integration", cloudplane.SubmitRequest{
		ID: "task-online", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "online"}, ComputerID: "computer-online", Payload: onlinePayload,
	}); err != nil || !created {
		t.Fatalf("online submit created=%t err=%v", created, err)
	}
	latestSnapshot, err := onlineStore.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := onlineStore.Close(); err != nil {
		t.Fatal(err)
	}
	onlineReport, err := migrator.VerifyFileSnapshot(ctx, latestSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if onlineReport.RowCounts["nodes"] != 1 || onlineReport.RowCounts["tasks"] != 1 {
		t.Fatalf("online mirror row counts=%v", onlineReport.RowCounts)
	}

	primary, err := NewPrimary(migrator)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists, err := primary.Load(ctx); err != nil || exists {
		t.Fatalf("unexpected PostgreSQL primary before cutover exists=%t err=%v", exists, err)
	}
	primaryRoot := t.TempDir()
	primaryStore, err := cloudplane.Open(primaryRoot, onlineProvisions, cloudplane.Options{
		StatePrimary: primary, StatePrimaryTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := primaryStore.RegisterNode("node-online", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	primaryPayload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-primary", ComputerID: "computer-online",
		Command: daemonrpc.Command{ID: "command-primary", SessionID: "session-primary", Argv: []string{"echo", "primary"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := primaryStore.Submit("spiffe://example.test/tenant/acme/project/online/client/primary", cloudplane.SubmitRequest{
		ID: "task-primary", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "online"}, ComputerID: "computer-online",
		Payload: primaryPayload,
	}); err != nil || !created {
		t.Fatalf("primary submit created=%t err=%v", created, err)
	}
	primarySnapshot, err := primaryStore.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := primaryStore.Close(); err != nil {
		t.Fatal(err)
	}
	loadedPrimary, exists, err := primary.Load(ctx)
	if err != nil || !exists {
		t.Fatalf("load PostgreSQL primary exists=%t err=%v", exists, err)
	}
	expectedPrimary, _ := primarySnapshot.CanonicalJSON()
	actualPrimary, _ := loadedPrimary.CanonicalJSON()
	if !bytes.Equal(expectedPrimary, actualPrimary) {
		t.Fatal("PostgreSQL primary snapshot differs from the latest committed Store state")
	}
	if _, err := connection.Exec(ctx, `UPDATE zapvm.tasks SET updated_at = updated_at + interval '1 second' WHERE id = 'task-primary'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := primary.Load(ctx); err == nil || !strings.Contains(err.Error(), "projection drift") {
		t.Fatalf("PostgreSQL primary projection drift error=%v", err)
	}
	if _, err := migrator.ImportFileSnapshot(ctx, primarySnapshot, FileImportOptions{RepairDrift: true}); err != nil {
		t.Fatalf("repair PostgreSQL primary projection: %v", err)
	}
	if _, exists, err := primary.Load(ctx); err != nil || !exists {
		t.Fatalf("load repaired PostgreSQL primary exists=%t err=%v", exists, err)
	}
	if err := os.WriteFile(filepath.Join(primaryRoot, "state.json"), []byte("{corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	recoveredStore, err := cloudplane.Open(primaryRoot, onlineProvisions, cloudplane.Options{
		StatePrimary: primary, StatePrimaryTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("recover primary over corrupt file cache: %v", err)
	}
	if nodes := recoveredStore.ListNodes(); len(nodes) != 1 || nodes[0].ID != "node-online" {
		t.Fatalf("recovered primary Nodes=%#v", nodes)
	}
	if err := recoveredStore.Close(); err != nil {
		t.Fatal(err)
	}
	rollbackStore, err := cloudplane.Open(primaryRoot, onlineProvisions, cloudplane.Options{})
	if err != nil {
		t.Fatalf("open single-file rollback cache: %v", err)
	}
	if task, err := rollbackStore.InspectTask(cloudplane.Scope{TenantID: "acme", ProjectID: "online"}, "task-primary"); err != nil || task.ID != "task-primary" {
		t.Fatalf("single-file rollback Task=%#v err=%v", task, err)
	}
	if err := rollbackStore.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.ImportFileSnapshot(ctx, primarySnapshot, FileImportOptions{}); err == nil || !strings.Contains(err.Error(), "primary Control state is initialized") {
		t.Fatalf("file mirror write after primary cutover error=%v", err)
	}
	if _, err := migrator.ImportFileSnapshot(ctx, primarySnapshot, FileImportOptions{RepairDrift: true}); err != nil {
		t.Fatalf("explicit primary repair from file snapshot: %v", err)
	}
	if _, err := connection.Exec(ctx, `DELETE FROM zapvm.primary_state`); err != nil {
		t.Fatal(err)
	}
}

type schemaKeyWrapper struct{}

func (schemaKeyWrapper) Wrap(_ context.Context, dataKey, aad []byte) (credentialkms.WrappedKey, error) {
	digest := sha256.Sum256(append(append([]byte(nil), dataKey...), aad...))
	return credentialkms.WrappedKey{Provider: "test-kms", KeyID: "keys/credential", KeyVersion: "v1", Ciphertext: digest[:]}, nil
}

func (schemaKeyWrapper) Unwrap(context.Context, credentialkms.WrappedKey, []byte) ([]byte, error) {
	return nil, errors.New("schema test wrapper cannot decrypt")
}

func testCredentialLedgerConstraints(t *testing.T, ctx context.Context, connection *pgxpool.Conn) {
	t.Helper()
	broker, err := credentialkms.New(schemaKeyWrapper{})
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("private-credential-value-must-not-enter-postgresql")
	envelope, err := broker.Seal(ctx, credentialkms.Binding{TenantID: "acme", ProjectID: "credential", CredentialID: "model-key", Version: 1}, secret)
	if err != nil {
		t.Fatal(err)
	}
	principal := sha256.Sum256([]byte("spiffe://example.test/tenant/acme/project/credential/client/admin"))
	capabilitySecret := sha256.Sum256([]byte("one-time-capability-secret"))
	transaction, err := connection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls','on',true)`); err != nil {
		t.Fatal(err)
	}
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO zapvm.nodes (id,generation,state,capacity,last_heartbeat,daemon_state) VALUES ('node-credential','generation-credential-0001','online',1,clock_timestamp(),'healthy')`, nil},
		{`INSERT INTO zapvm.node_scopes (node_id,tenant_id,project_id) VALUES ('node-credential','acme','credential')`, nil},
		{`INSERT INTO zapvm.computers (tenant_id,project_id,computer_id) VALUES ('acme','credential','computer-credential')`, nil},
		{`INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ('acme','credential','computer-credential','node-credential')`, nil},
		{`INSERT INTO zapvm.tasks (id,tenant_id,project_id,computer_id,payload,payload_sha256,credential_ids,state,created_at,created_sequence,updated_at) VALUES ('task-credential','acme','credential','computer-credential','{}',decode(repeat('11',32),'hex'),ARRAY['model-key'],'pending',clock_timestamp(),9001,clock_timestamp())`, nil},
		{`INSERT INTO zapvm.credential_envelopes (tenant_id,project_id,credential_id,version,state,envelope_schema,algorithm,kms_provider,kms_key_id,kms_key_version,wrapped_data_key,nonce,ciphertext,aad_sha256,created_by_sha256,created_at,updated_at) VALUES ('acme','credential','model-key',1,'active',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,transaction_timestamp(),transaction_timestamp())`, []any{envelope.SchemaVersion, envelope.Algorithm, envelope.WrappedKey.Provider, envelope.WrappedKey.KeyID, envelope.WrappedKey.KeyVersion, envelope.WrappedKey.Ciphertext, envelope.Nonce, envelope.Ciphertext, envelope.AADSHA256, principal[:]}},
		{`INSERT INTO zapvm.credential_capabilities (capability_id,secret_sha256,tenant_id,project_id,task_id,node_id,node_generation,state,issued_at,expires_at) VALUES ('capability-credential-0001',$1,'acme','credential','task-credential','node-credential','generation-credential-0001','issued',transaction_timestamp(),transaction_timestamp()+interval '5 minutes')`, []any{capabilitySecret[:]}},
		{`INSERT INTO zapvm.credential_capability_items (tenant_id,project_id,capability_id,credential_id,credential_version) VALUES ('acme','credential','capability-credential-0001','model-key',1)`, nil},
		{`INSERT INTO zapvm.credential_access_audit (sequence,schema_version,occurred_at,action,tenant_id,project_id,capability_id,task_id,node_id,node_generation,principal_sha256,outcome,sha256) VALUES (1,1,transaction_timestamp(),'capability_issue','acme','credential','capability-credential-0001','task-credential','node-credential','generation-credential-0001',$1,'issued',decode(repeat('22',32),'hex'))`, []any{principal[:]}},
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("credential ledger fixture: %v", err)
		}
	}
	var persisted []byte
	if err := transaction.QueryRow(ctx, `SELECT wrapped_data_key || nonce || ciphertext || aad_sha256 FROM zapvm.credential_envelopes WHERE tenant_id='acme' AND project_id='credential' AND credential_id='model-key' AND version=1`).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(persisted, secret) {
		t.Fatal("Credential plaintext entered PostgreSQL envelope columns")
	}
	for _, invalid := range []string{
		`INSERT INTO zapvm.credential_capabilities (capability_id,secret_sha256,tenant_id,project_id,task_id,node_id,node_generation,state,issued_at,expires_at) VALUES ('capability-too-long-0001',decode(repeat('33',32),'hex'),'acme','credential','task-credential','node-credential','generation-credential-0001','issued',transaction_timestamp(),transaction_timestamp()+interval '16 minutes')`,
		`INSERT INTO zapvm.credential_capabilities (capability_id,secret_sha256,tenant_id,project_id,task_id,node_id,node_generation,state,issued_at,expires_at) VALUES ('capability-redeemed-0001',decode(repeat('44',32),'hex'),'acme','credential','task-credential','node-credential','generation-credential-0001','redeemed',transaction_timestamp(),transaction_timestamp()+interval '5 minutes')`,
		`INSERT INTO zapvm.credential_envelopes (tenant_id,project_id,credential_id,version,state,envelope_schema,algorithm,kms_provider,kms_key_id,kms_key_version,wrapped_data_key,nonce,ciphertext,aad_sha256,created_by_sha256,created_at,updated_at) SELECT tenant_id,project_id,credential_id,2,'active',envelope_schema,algorithm,kms_provider,kms_key_id,kms_key_version,wrapped_data_key,nonce,ciphertext,aad_sha256,created_by_sha256,created_at,updated_at FROM zapvm.credential_envelopes WHERE version=1`,
	} {
		if _, err := transaction.Exec(ctx, `SAVEPOINT invalid_credential_ledger`); err != nil {
			t.Fatal(err)
		}
		if _, err := transaction.Exec(ctx, invalid); err == nil {
			t.Fatalf("invalid Credential ledger row accepted: %s", invalid)
		}
		if _, err := transaction.Exec(ctx, `ROLLBACK TO SAVEPOINT invalid_credential_ledger`); err != nil {
			t.Fatal(err)
		}
	}
}

func controlFileSnapshot(t *testing.T) cloudplane.OfflineSnapshot {
	t.Helper()
	now := time.Date(2026, 8, 8, 2, 3, 4, 0, time.UTC)
	provisions := []cloudplane.NodeProvision{{
		ID: "node-import", Capacity: 2,
		Scopes:    []cloudplane.Scope{{TenantID: "acme", ProjectID: "default"}},
		Computers: []cloudplane.ComputerProvision{{ID: "computer-import", TenantID: "acme", ProjectID: "default"}},
	}}
	store, err := cloudplane.Open(t.TempDir(), provisions, cloudplane.Options{
		Now: func() time.Time { return now }, Random: bytes.NewReader(bytes.Repeat([]byte{0x42}, 4096)),
		HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.RegisterNode("node-import", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-import", ComputerID: "computer-import",
		Command: daemonrpc.Command{ID: "command-import", SessionID: "session-import", Argv: []string{"echo", "ok"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.Submit("spiffe://example.test/tenant/acme/project/default/client/import", cloudplane.SubmitRequest{
		ID: "task-import", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "default"}, ComputerID: "computer-import", Payload: payload,
	}); err != nil || !created {
		t.Fatalf("submit created=%t err=%v", created, err)
	}
	leases, err := store.Claim("node-import", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim leases=%#v err=%v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-import", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.AppendTaskEvent("node-import", "generation-00001", lease.Task.ID, lease.LeaseToken, daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: now.Format(time.RFC3339Nano), TaskID: lease.Task.ID, Type: "command.stdout", CommandID: "command-import", Stream: "stdout", Data: []byte("ok\n"),
	}); err != nil || !created {
		t.Fatalf("event created=%t err=%v", created, err)
	}
	if _, err := store.Complete("node-import", "generation-00001", lease.Task.ID, lease.LeaseToken, cloudplane.Completion{Succeeded: true, ResultSHA256: strings.Repeat("ab", 32)}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestFileSnapshotProjectionRejectsPostgreSQLBigintOverflow(t *testing.T) {
	snapshot := controlFileSnapshot(t)
	var state snapshotState
	if err := json.Unmarshal(snapshot.StateJSON, &state); err != nil {
		t.Fatal(err)
	}
	state.DispatchSequence = math.MaxUint64
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.StateJSON = data
	if _, _, err := buildSnapshotProjection(snapshot); err == nil || !strings.Contains(err.Error(), "bigint") {
		t.Fatalf("overflow projection error=%v", err)
	}
}

func migratorChecksum(t *testing.T, migrator *Migrator, index int) string {
	t.Helper()
	if index < 0 || index >= len(migrator.migrations) {
		t.Fatal(errors.New("migration index is invalid"))
	}
	return hex.EncodeToString(migrator.migrations[index].Checksum[:])
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
