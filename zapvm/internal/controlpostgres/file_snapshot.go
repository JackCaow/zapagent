package controlpostgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

const (
	snapshotImportLockID   int64 = 0x5a4150564d444202
	maxPrimarySnapshotSize       = 65 << 20
)

type FileImportOptions struct {
	RepairDrift      bool
	ReplaceUntracked bool
}

type FileImportReport struct {
	Changed        bool             `json:"changed"`
	SnapshotFormat int              `json:"snapshot_format_version"`
	StateSchema    int              `json:"source_state_schema_version"`
	SourceSHA256   string           `json:"source_sha256"`
	DatabaseSHA256 string           `json:"database_sha256"`
	RowCounts      map[string]int64 `json:"row_counts"`
	ImportedAt     time.Time        `json:"imported_at"`
}

type snapshotState struct {
	SchemaVersion       int                                      `json:"schema_version"`
	Sequence            uint64                                   `json:"sequence"`
	DispatchSequence    uint64                                   `json:"dispatch_sequence"`
	Nodes               map[string]cloudplane.Node               `json:"nodes"`
	Tasks               map[string]cloudplane.Task               `json:"tasks"`
	Events              map[string][]cloudplane.TaskEvent        `json:"events"`
	WorkspaceOperations map[string]cloudplane.WorkspaceOperation `json:"workspace_operations"`
	Artifacts           map[string]cloudplane.Artifact           `json:"artifacts"`
	ScopeDispatch       map[string]uint64                        `json:"scope_dispatch"`
	Audit               []cloudplane.AuditRecord                 `json:"audit"`
}

type copyTable struct {
	name    string
	columns []string
	rows    [][]any
}

type snapshotProjection struct {
	stateSchema      int
	auditSequence    int64
	dispatchSequence int64
	tables           []copyTable
}

type computerProjection struct {
	tenantID  string
	projectID string
	id        string
	agent     string
	createdAt *time.Time
	nodes     map[string]struct{}
}

type sessionProjection struct {
	tenantID  string
	projectID string
	id        string
	computer  string
	createdAt time.Time
	updatedAt time.Time
}

type mirrorMetadata struct {
	snapshotFormat int
	stateSchema    int
	sourceDigest   []byte
	databaseDigest []byte
	rowCounts      map[string]int64
	importedAt     time.Time
}

func (migrator *Migrator) ImportFileSnapshot(ctx context.Context, snapshot cloudplane.OfflineSnapshot, options FileImportOptions) (FileImportReport, error) {
	return migrator.importSnapshot(ctx, snapshot, options, false)
}

// CommitPrimarySnapshot atomically updates the normalized Control projection
// and the exact validated snapshot used to recover a single-active Control.
// It intentionally shares the same drift and untracked-state gates as the
// offline importer; a primary cutover cannot silently replace unknown data.
func (migrator *Migrator) CommitPrimarySnapshot(ctx context.Context, snapshot cloudplane.OfflineSnapshot) (FileImportReport, error) {
	return migrator.importSnapshot(ctx, snapshot, FileImportOptions{}, true)
}

func (migrator *Migrator) importSnapshot(ctx context.Context, snapshot cloudplane.OfflineSnapshot, options FileImportOptions, recordPrimary bool) (FileImportReport, error) {
	if migrator == nil || migrator.pool == nil || ctx == nil {
		return FileImportReport{}, errors.New("PostgreSQL migrator is not open")
	}
	projection, sourceDigest, err := buildSnapshotProjection(snapshot)
	if err != nil {
		return FileImportReport{}, err
	}
	connection, err := migrator.pool.Acquire(ctx)
	if err != nil {
		return FileImportReport{}, errors.New("acquire PostgreSQL file import connection")
	}
	defer connection.Release()
	transaction, err := connection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return FileImportReport{}, errors.New("begin PostgreSQL file import")
	}
	defer rollbackBounded(transaction)
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock($1), pg_advisory_xact_lock($2)`, advisoryLockID, snapshotImportLockID); err != nil {
		return FileImportReport{}, errors.New("acquire PostgreSQL file import lock")
	}
	if err := migrator.requireCurrentSchema(ctx, transaction); err != nil {
		return FileImportReport{}, err
	}
	if err := enableOwnerBypass(ctx, transaction); err != nil {
		return FileImportReport{}, err
	}
	writePrimary := recordPrimary
	if !recordPrimary {
		var primaryExists bool
		if err := transaction.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM zapvm.primary_state WHERE singleton)`).Scan(&primaryExists); err != nil {
			return FileImportReport{}, databaseFailure("inspect PostgreSQL primary Control state", err)
		}
		if primaryExists {
			if !options.RepairDrift {
				return FileImportReport{}, errors.New("PostgreSQL primary Control state is initialized; file mirror writes are disabled")
			}
			writePrimary = true
		}
	}
	metadata, metadataExists, err := readMirrorMetadata(ctx, transaction)
	if err != nil {
		return FileImportReport{}, err
	}
	currentDigest, currentCounts, err := databaseStateDigest(ctx, transaction)
	if err != nil {
		return FileImportReport{}, err
	}
	if metadataExists && !bytes.Equal(currentDigest, metadata.databaseDigest) && !options.RepairDrift {
		return FileImportReport{}, errors.New("PostgreSQL file mirror drift detected; explicit repair is required")
	}
	if metadataExists && bytes.Equal(sourceDigest, metadata.sourceDigest) && bytes.Equal(currentDigest, metadata.databaseDigest) {
		if writePrimary {
			if err := writePrimaryState(ctx, transaction, snapshot, sourceDigest, currentDigest); err != nil {
				return FileImportReport{}, err
			}
		}
		if err := transaction.Commit(ctx); err != nil {
			return FileImportReport{}, errors.New("commit PostgreSQL file import verification")
		}
		return reportFromMetadata(false, metadata), nil
	}
	if !metadataExists && hasTrackedRows(currentCounts) && !options.ReplaceUntracked {
		return FileImportReport{}, errors.New("PostgreSQL contains untracked Control state; explicit replacement is required")
	}
	if err := clearProjectedState(ctx, transaction); err != nil {
		return FileImportReport{}, err
	}
	for _, table := range projection.tables {
		if len(table.rows) == 0 {
			continue
		}
		if _, err := transaction.CopyFrom(ctx, pgx.Identifier{"zapvm", table.name}, table.columns, pgx.CopyFromRows(table.rows)); err != nil {
			return FileImportReport{}, databaseFailure("import PostgreSQL "+table.name, err)
		}
	}
	var importedAt time.Time
	if err := transaction.QueryRow(ctx, `UPDATE zapvm.control_state SET audit_sequence = $1, dispatch_sequence = $2, updated_at = clock_timestamp() WHERE singleton RETURNING updated_at`, projection.auditSequence, projection.dispatchSequence).Scan(&importedAt); err != nil {
		return FileImportReport{}, databaseFailure("update PostgreSQL Control sequence", err)
	}
	databaseDigest, rowCounts, err := databaseStateDigest(ctx, transaction)
	if err != nil {
		return FileImportReport{}, err
	}
	rowCountsJSON, err := json.Marshal(rowCounts)
	if err != nil {
		return FileImportReport{}, errors.New("encode PostgreSQL file import counts")
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.file_mirror_state
    (singleton, snapshot_format_version, source_state_schema_version, source_sha256, database_sha256, row_counts, imported_at)
VALUES (true, $1, $2, $3, $4, $5, $6)
ON CONFLICT (singleton) DO UPDATE SET
    snapshot_format_version = EXCLUDED.snapshot_format_version,
    source_state_schema_version = EXCLUDED.source_state_schema_version,
    source_sha256 = EXCLUDED.source_sha256,
    database_sha256 = EXCLUDED.database_sha256,
    row_counts = EXCLUDED.row_counts,
    imported_at = EXCLUDED.imported_at`, snapshot.FormatVersion, projection.stateSchema, sourceDigest, databaseDigest, rowCountsJSON, importedAt); err != nil {
		return FileImportReport{}, databaseFailure("record PostgreSQL file import", err)
	}
	if writePrimary {
		if err := writePrimaryState(ctx, transaction, snapshot, sourceDigest, databaseDigest); err != nil {
			return FileImportReport{}, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return FileImportReport{}, databaseFailure("commit PostgreSQL file import", err)
	}
	return FileImportReport{
		Changed: true, SnapshotFormat: snapshot.FormatVersion, StateSchema: projection.stateSchema,
		SourceSHA256: hex.EncodeToString(sourceDigest), DatabaseSHA256: hex.EncodeToString(databaseDigest),
		RowCounts: rowCounts, ImportedAt: importedAt,
	}, nil
}

func writePrimaryState(ctx context.Context, transaction pgx.Tx, snapshot cloudplane.OfflineSnapshot, sourceDigest, databaseDigest []byte) error {
	canonical, err := snapshot.CanonicalJSON()
	if err != nil {
		return err
	}
	if len(canonical) > maxPrimarySnapshotSize {
		return errors.New("cloud control-plane primary snapshot exceeds its size limit")
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.primary_state
    (singleton, generation, snapshot, source_sha256, database_sha256, committed_at)
VALUES (true, 1, $1, $2, $3, clock_timestamp())
ON CONFLICT (singleton) DO UPDATE SET
    generation = zapvm.primary_state.generation + 1,
    snapshot = EXCLUDED.snapshot,
    source_sha256 = EXCLUDED.source_sha256,
    database_sha256 = EXCLUDED.database_sha256,
    committed_at = EXCLUDED.committed_at`, canonical, sourceDigest, databaseDigest); err != nil {
		return databaseFailure("record PostgreSQL primary Control state", err)
	}
	return nil
}

func (migrator *Migrator) VerifyFileSnapshot(ctx context.Context, snapshot cloudplane.OfflineSnapshot) (FileImportReport, error) {
	if migrator == nil || migrator.pool == nil || ctx == nil {
		return FileImportReport{}, errors.New("PostgreSQL migrator is not open")
	}
	projection, sourceDigest, err := buildSnapshotProjection(snapshot)
	if err != nil {
		return FileImportReport{}, err
	}
	connection, err := migrator.pool.Acquire(ctx)
	if err != nil {
		return FileImportReport{}, errors.New("acquire PostgreSQL file verification connection")
	}
	defer connection.Release()
	transaction, err := connection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable, AccessMode: pgx.ReadOnly})
	if err != nil {
		return FileImportReport{}, errors.New("begin PostgreSQL file verification")
	}
	defer rollbackBounded(transaction)
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1), pg_advisory_xact_lock_shared($2)`, advisoryLockID, snapshotImportLockID); err != nil {
		return FileImportReport{}, errors.New("acquire PostgreSQL file verification lock")
	}
	if err := migrator.requireCurrentSchema(ctx, transaction); err != nil {
		return FileImportReport{}, err
	}
	if err := enableOwnerBypass(ctx, transaction); err != nil {
		return FileImportReport{}, err
	}
	metadata, exists, err := readMirrorMetadata(ctx, transaction)
	if err != nil {
		return FileImportReport{}, err
	}
	if !exists {
		return FileImportReport{}, errors.New("PostgreSQL file mirror has not been initialized")
	}
	if metadata.snapshotFormat != snapshot.FormatVersion || metadata.stateSchema != projection.stateSchema || !bytes.Equal(metadata.sourceDigest, sourceDigest) {
		return FileImportReport{}, errors.New("PostgreSQL file mirror source differs from state.json")
	}
	databaseDigest, rowCounts, err := databaseStateDigest(ctx, transaction)
	if err != nil {
		return FileImportReport{}, err
	}
	if !bytes.Equal(databaseDigest, metadata.databaseDigest) || !equalRowCounts(rowCounts, metadata.rowCounts) {
		return FileImportReport{}, errors.New("PostgreSQL file mirror database drift detected")
	}
	if err := transaction.Commit(ctx); err != nil {
		return FileImportReport{}, errors.New("commit PostgreSQL file verification")
	}
	return reportFromMetadata(false, metadata), nil
}

func (migrator *Migrator) requireCurrentSchema(ctx context.Context, transaction pgx.Tx) error {
	rows, err := transaction.Query(ctx, `SELECT version, name, encode(checksum, 'hex') FROM zapvm.schema_migrations ORDER BY version`)
	if err != nil {
		return errors.New("inspect PostgreSQL schema before file import")
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		if index >= len(migrator.migrations) {
			return errors.New("PostgreSQL schema is newer than this binary")
		}
		var version int64
		var name string
		var checksum string
		if err := rows.Scan(&version, &name, &checksum); err != nil {
			return errors.New("decode PostgreSQL schema before file import")
		}
		expected := migrator.migrations[index]
		if version != expected.Version || name != expected.Name || checksum != fmt.Sprintf("%x", expected.Checksum) {
			return errors.New("PostgreSQL schema differs from this binary")
		}
		index++
	}
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL schema before file import")
	}
	if index != len(migrator.migrations) {
		return errors.New("PostgreSQL schema migration is pending")
	}
	return nil
}

func buildSnapshotProjection(snapshot cloudplane.OfflineSnapshot) (snapshotProjection, []byte, error) {
	canonical, err := snapshot.CanonicalJSON()
	if err != nil {
		return snapshotProjection{}, nil, err
	}
	var state snapshotState
	decoder := json.NewDecoder(bytes.NewReader(snapshot.StateJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return snapshotProjection{}, nil, errors.New("decode validated cloud control-plane snapshot")
	}
	if state.SchemaVersion != snapshot.StateSchemaVersion || state.Nodes == nil || state.Tasks == nil || state.Events == nil || state.WorkspaceOperations == nil || state.Artifacts == nil || state.ScopeDispatch == nil || state.Audit == nil {
		return snapshotProjection{}, nil, errors.New("cloud control-plane snapshot schema is invalid")
	}
	if state.Sequence != uint64(len(state.Audit)) || len(state.Events) != len(state.Tasks) {
		return snapshotProjection{}, nil, errors.New("cloud control-plane snapshot sequence or journal inventory is invalid")
	}
	for index, record := range state.Audit {
		if record.Sequence != uint64(index+1) {
			return snapshotProjection{}, nil, errors.New("cloud control-plane snapshot audit sequence is invalid")
		}
	}
	for taskID, events := range state.Events {
		if _, exists := state.Tasks[taskID]; !exists {
			return snapshotProjection{}, nil, errors.New("cloud control-plane snapshot journal references an unknown Task")
		}
		for _, event := range events {
			if event.TaskID != taskID {
				return snapshotProjection{}, nil, errors.New("cloud control-plane snapshot event authority differs from its journal")
			}
		}
	}
	for _, provision := range snapshot.Provisions {
		if err := provision.Validate(); err != nil {
			return snapshotProjection{}, nil, errors.New("cloud control-plane snapshot provision is invalid")
		}
	}
	projection, err := projectSnapshot(state, snapshot.Provisions)
	if err != nil {
		return snapshotProjection{}, nil, err
	}
	digest := sha256.Sum256(canonical)
	return projection, digest[:], nil
}

func projectSnapshot(state snapshotState, provisions []cloudplane.NodeProvision) (snapshotProjection, error) {
	auditSequence, err := signedUint64(state.Sequence)
	if err != nil {
		return snapshotProjection{}, err
	}
	dispatchSequence, err := signedUint64(state.DispatchSequence)
	if err != nil {
		return snapshotProjection{}, err
	}
	projection := snapshotProjection{stateSchema: state.SchemaVersion, auditSequence: auditSequence, dispatchSequence: dispatchSequence}
	provisionByNode := make(map[string]cloudplane.NodeProvision, len(provisions))
	for _, provision := range provisions {
		if _, duplicate := provisionByNode[provision.ID]; duplicate {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot contains duplicate provisions")
		}
		provisionByNode[provision.ID] = provision
	}

	nodes := sortedNodeIDs(state.Nodes)
	nodeRows := make([][]any, 0, len(nodes))
	scopeRows := make([][]any, 0)
	for _, id := range nodes {
		node := state.Nodes[id]
		if id != node.ID {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot Node identity differs from its key")
		}
		provision, provisioned := provisionByNode[id]
		if provisioned {
			if node.Capacity != provision.Capacity || !sameScopes(node.Scopes, provision.Scopes) {
				return snapshotProjection{}, errors.New("cloud control-plane snapshot Node authority differs from its provision")
			}
		} else if len(node.Scopes) != 0 {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot unprovisioned Node retains scope authority")
		}
		lastHeartbeat, err := requiredTime(node.LastHeartbeat)
		if err != nil {
			return snapshotProjection{}, err
		}
		imageDigest, err := optionalHex(node.ImageDigest)
		if err != nil {
			return snapshotProjection{}, err
		}
		startAttempts, err := signedUint64(node.StartAttempts)
		if err != nil {
			return snapshotProjection{}, err
		}
		startFailures, err := signedUint64(node.StartFailures)
		if err != nil {
			return snapshotProjection{}, err
		}
		startDurationTotal, err := signedUint64(node.StartDurationMillisTotal)
		if err != nil {
			return snapshotProjection{}, err
		}
		startDurationMax, err := signedUint64(node.StartDurationMillisMax)
		if err != nil {
			return snapshotProjection{}, err
		}
		nodeRows = append(nodeRows, []any{
			node.ID, node.Generation, node.State, int32(node.Capacity), int32(node.InFlight), lastHeartbeat,
			optionalString(node.NodeVersion), optionalString(node.DaemonVersion), imageDigest, node.DaemonState,
			optionalString(node.FailureCode), startAttempts, startFailures,
			startDurationTotal, startDurationMax, lastHeartbeat,
		})
		if provisioned {
			for _, scope := range provision.Scopes {
				scopeRows = append(scopeRows, []any{id, scope.TenantID, scope.ProjectID})
			}
		}
	}
	sort.Slice(scopeRows, func(left, right int) bool { return joinedRowKey(scopeRows[left]) < joinedRowKey(scopeRows[right]) })
	projection.tables = append(projection.tables,
		copyTable{name: "nodes", columns: []string{"id", "generation", "state", "capacity", "in_flight", "last_heartbeat", "node_version", "daemon_version", "image_digest", "daemon_state", "failure_code", "start_attempts", "start_failures", "start_duration_ms_total", "start_duration_ms_max", "updated_at"}, rows: nodeRows},
		copyTable{name: "node_scopes", columns: []string{"node_id", "tenant_id", "project_id"}, rows: scopeRows},
	)

	computers, err := projectComputers(state, provisions)
	if err != nil {
		return snapshotProjection{}, err
	}
	computerKeys := make([]string, 0, len(computers))
	for key := range computers {
		computerKeys = append(computerKeys, key)
	}
	sort.Strings(computerKeys)
	computerRows := make([][]any, 0, len(computerKeys))
	computerNodeRows := make([][]any, 0)
	for _, key := range computerKeys {
		computer := computers[key]
		computerRows = append(computerRows, []any{computer.tenantID, computer.projectID, computer.id, computer.agent, computer.createdAt})
		nodeIDs := make([]string, 0, len(computer.nodes))
		for nodeID := range computer.nodes {
			if _, registered := state.Nodes[nodeID]; registered {
				nodeIDs = append(nodeIDs, nodeID)
			}
		}
		sort.Strings(nodeIDs)
		for _, nodeID := range nodeIDs {
			computerNodeRows = append(computerNodeRows, []any{computer.tenantID, computer.projectID, computer.id, nodeID})
		}
	}
	projection.tables = append(projection.tables,
		copyTable{name: "computers", columns: []string{"tenant_id", "project_id", "computer_id", "agent", "created_at"}, rows: computerRows},
		copyTable{name: "computer_nodes", columns: []string{"tenant_id", "project_id", "computer_id", "node_id"}, rows: computerNodeRows},
	)

	taskIDs := sortedTaskIDs(state.Tasks)
	sessions := make(map[string]sessionProjection)
	taskRows := make([][]any, 0, len(taskIDs))
	for _, id := range taskIDs {
		task := state.Tasks[id]
		if id != task.ID {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot Task identity differs from its key")
		}
		createdAt, err := requiredTime(task.CreatedAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		updatedAt, err := requiredTime(task.UpdatedAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		payloadDigest, err := requiredHex(task.PayloadSHA256)
		if err != nil {
			return snapshotProjection{}, err
		}
		actualPayloadDigest := sha256.Sum256(task.Payload)
		if !bytes.Equal(payloadDigest, actualPayloadDigest[:]) {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot Task payload digest differs")
		}
		leaseDigest, err := optionalHex(task.LeaseTokenHash)
		if err != nil {
			return snapshotProjection{}, err
		}
		resultDigest, err := optionalHex(task.ResultSHA256)
		if err != nil {
			return snapshotProjection{}, err
		}
		leaseExpiresAt, err := optionalTime(task.LeaseExpiresAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		queueDeadline, err := optionalTime(task.QueueDeadline)
		if err != nil {
			return snapshotProjection{}, err
		}
		createdSequence, err := signedUint64(task.CreatedSequence)
		if err != nil {
			return snapshotProjection{}, err
		}
		dispatchSequence, err := optionalPositiveInt64(task.DispatchSequence)
		if err != nil {
			return snapshotProjection{}, err
		}
		command, err := daemonrpc.DecodeComputerTaskSubmit(task.Payload)
		if err != nil {
			return snapshotProjection{}, errors.New("decode cloud control-plane snapshot Task authority")
		}
		if command.ComputerID != task.ComputerID || (command.ID != "" && command.ID != task.ID) || !sameStrings(command.Command.CredentialIDs, task.CredentialIDs) {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot Task authority differs from its envelope")
		}
		if task.RetryOf != "" {
			source, exists := state.Tasks[task.RetryOf]
			if !exists || source.TenantID != task.TenantID || source.ProjectID != task.ProjectID || source.ComputerID != task.ComputerID || !terminalTaskState(source.State) {
				return snapshotProjection{}, errors.New("cloud control-plane snapshot Task retry lineage is invalid")
			}
		}
		// Command SessionID is also used by ordinary shell/tool execution and is
		// only Computer-local in the legacy file backend. Only Resident Agent
		// tasks participate in the scope-wide Agent Session relation.
		sessionID := residentAgentSessionID(command)
		if sessionID != "" {
			key := scopeKey(task.TenantID, task.ProjectID) + "\x00" + sessionID
			session, exists := sessions[key]
			if !exists {
				session = sessionProjection{tenantID: task.TenantID, projectID: task.ProjectID, id: sessionID, computer: task.ComputerID, createdAt: createdAt, updatedAt: updatedAt}
			} else {
				if session.computer != task.ComputerID {
					return snapshotProjection{}, errors.New("cloud control-plane snapshot Session spans multiple Computers")
				}
				if createdAt.Before(session.createdAt) {
					session.createdAt = createdAt
				}
				if updatedAt.After(session.updatedAt) {
					session.updatedAt = updatedAt
				}
			}
			sessions[key] = session
		}
		credentialIDs := append([]string{}, task.CredentialIDs...)
		taskRows = append(taskRows, []any{
			task.ID, task.TenantID, task.ProjectID, task.ComputerID, optionalString(sessionID), json.RawMessage(task.Payload), append([]byte(nil), task.Payload...), payloadDigest,
			credentialIDs, optionalString(task.RetryOf), task.State, optionalString(task.NodeID), optionalString(task.NodeGeneration),
			int32(task.Attempt), leaseDigest, leaseExpiresAt, createdAt, createdSequence, updatedAt,
			resultDigest, optionalString(task.FailureCode), dispatchSequence, optionalString(task.QueueReason), queueDeadline,
		})
	}
	sessionKeys := make([]string, 0, len(sessions))
	for key := range sessions {
		sessionKeys = append(sessionKeys, key)
	}
	sort.Strings(sessionKeys)
	sessionRows := make([][]any, 0, len(sessionKeys))
	for _, key := range sessionKeys {
		session := sessions[key]
		sessionRows = append(sessionRows, []any{session.tenantID, session.projectID, session.id, session.computer, session.createdAt, session.updatedAt})
	}
	projection.tables = append(projection.tables,
		copyTable{name: "agent_sessions", columns: []string{"tenant_id", "project_id", "session_id", "computer_id", "created_at", "updated_at"}, rows: sessionRows},
		copyTable{name: "tasks", columns: []string{"id", "tenant_id", "project_id", "computer_id", "session_id", "payload", "payload_raw", "payload_sha256", "credential_ids", "retry_of", "state", "node_id", "node_generation", "attempt", "lease_token_hash", "lease_expires_at", "created_at", "created_sequence", "updated_at", "result_sha256", "failure_code", "dispatch_sequence", "queue_reason", "queue_deadline"}, rows: taskRows},
	)

	eventRows := make([][]any, 0)
	for _, taskID := range taskIDs {
		task := state.Tasks[taskID]
		for _, event := range state.Events[taskID] {
			occurredAt, err := requiredTime(event.Timestamp)
			if err != nil {
				return snapshotProjection{}, err
			}
			cursor, err := signedUint64(event.Cursor)
			if err != nil {
				return snapshotProjection{}, err
			}
			sourceCursor, err := signedUint64(event.SourceCursor)
			if err != nil {
				return snapshotProjection{}, err
			}
			eventRows = append(eventRows, []any{
				task.TenantID, task.ProjectID, taskID, cursor, int32(event.Attempt), sourceCursor, occurredAt,
				event.Type, optionalString(event.CommandID), optionalString(event.Stream), optionalBytes(event.Data), optionalNonnegativeInt(event.PID), optionalBool(event.OK), optionalString(event.Error),
			})
		}
	}
	projection.tables = append(projection.tables, copyTable{name: "task_events", columns: []string{"tenant_id", "project_id", "task_id", "cursor", "attempt", "source_cursor", "occurred_at", "type", "command_id", "stream", "data", "pid", "ok", "error"}, rows: eventRows})

	operationIDs := sortedOperationIDs(state.WorkspaceOperations)
	operationRows := make([][]any, 0, len(operationIDs))
	for _, id := range operationIDs {
		operation := state.WorkspaceOperations[id]
		if id != operation.ID {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot workspace operation identity differs from its key")
		}
		createdAt, err := requiredTime(operation.CreatedAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		updatedAt, err := requiredTime(operation.UpdatedAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		expiresAt, err := requiredTime(operation.ExpiresAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		leaseExpiresAt, err := optionalTime(operation.LeaseExpiresAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		leaseDigest, err := optionalHex(operation.LeaseTokenHash)
		if err != nil {
			return snapshotProjection{}, err
		}
		resultDigest, err := optionalHex(operation.ResultSHA256)
		if err != nil {
			return snapshotProjection{}, err
		}
		createdSequence, err := signedUint64(operation.CreatedSequence)
		if err != nil {
			return snapshotProjection{}, err
		}
		operationRows = append(operationRows, []any{
			operation.ID, operation.TenantID, operation.ProjectID, operation.ComputerID, operation.Kind, nullablePath(operation),
			optionalString(operation.TaskID), optionalString(operation.ProviderID), optionalString(operation.Branch), operation.State,
			optionalString(operation.NodeID), optionalString(operation.NodeGeneration), int32(operation.Attempt), leaseDigest, leaseExpiresAt,
			createdAt, updatedAt, expiresAt, optionalJSON(operation.Result), optionalBytes(operation.Result), resultDigest, optionalString(operation.FailureCode), createdSequence,
		})
	}
	projection.tables = append(projection.tables, copyTable{name: "workspace_operations", columns: []string{"id", "tenant_id", "project_id", "computer_id", "kind", "path", "task_id", "provider_id", "branch", "state", "node_id", "node_generation", "attempt", "lease_token_hash", "lease_expires_at", "created_at", "updated_at", "expires_at", "result", "result_raw", "result_sha256", "failure_code", "created_sequence"}, rows: operationRows})

	artifactIDs := sortedArtifactIDs(state.Artifacts)
	artifactRows := make([][]any, 0, len(artifactIDs))
	for _, id := range artifactIDs {
		artifact := state.Artifacts[id]
		if id != artifact.ID {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot Artifact identity differs from its key")
		}
		createdAt, err := requiredTime(artifact.CreatedAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		updatedAt, err := requiredTime(artifact.UpdatedAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		expiresAt, err := requiredTime(artifact.ExpiresAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		availableAt, err := optionalTime(artifact.AvailableAt)
		if err != nil {
			return snapshotProjection{}, err
		}
		digest, err := requiredHex(artifact.SHA256)
		if err != nil {
			return snapshotProjection{}, err
		}
		size, err := signedUint64(artifact.Size)
		if err != nil {
			return snapshotProjection{}, err
		}
		retention, err := signedUint64(artifact.RetentionSeconds)
		if err != nil {
			return snapshotProjection{}, err
		}
		createdSequence, err := signedUint64(artifact.CreatedSequence)
		if err != nil {
			return snapshotProjection{}, err
		}
		artifactRows = append(artifactRows, []any{
			artifact.ID, artifact.TenantID, artifact.ProjectID, artifact.ComputerID, artifact.SessionID, artifact.TaskID,
			artifact.Path, artifact.Name, artifact.ContentType, size, digest, artifact.State, retention,
			createdAt, updatedAt, expiresAt, optionalString(artifact.FailureCode), optionalString(artifact.ObjectKey), availableAt,
			createdSequence, artifact.RegisteredNodeID, artifact.RegisteredNodeGeneration,
		})
	}
	projection.tables = append(projection.tables, copyTable{name: "artifacts", columns: []string{"id", "tenant_id", "project_id", "computer_id", "session_id", "task_id", "path", "name", "content_type", "size_bytes", "sha256", "state", "retention_seconds", "created_at", "updated_at", "expires_at", "failure_code", "object_key", "available_at", "created_sequence", "registered_node_id", "registered_node_generation"}, rows: artifactRows})

	dispatchKeys := make([]string, 0, len(state.ScopeDispatch))
	for key := range state.ScopeDispatch {
		dispatchKeys = append(dispatchKeys, key)
	}
	sort.Strings(dispatchKeys)
	dispatchRows := make([][]any, 0, len(dispatchKeys))
	for _, key := range dispatchKeys {
		parts := strings.Split(key, "\x00")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return snapshotProjection{}, errors.New("cloud control-plane snapshot scope dispatch key is invalid")
		}
		cursor, err := signedUint64(state.ScopeDispatch[key])
		if err != nil {
			return snapshotProjection{}, err
		}
		dispatchRows = append(dispatchRows, []any{parts[0], parts[1], cursor})
	}
	projection.tables = append(projection.tables, copyTable{name: "scope_dispatch", columns: []string{"tenant_id", "project_id", "dispatch_cursor"}, rows: dispatchRows})

	auditRows := make([][]any, 0, len(state.Audit))
	for _, record := range state.Audit {
		occurredAt, err := requiredTime(record.Timestamp)
		if err != nil {
			return snapshotProjection{}, err
		}
		principalDigest, err := optionalHex(record.PrincipalSHA256)
		if err != nil {
			return snapshotProjection{}, err
		}
		previousDigest, err := optionalHex(record.PreviousSHA256)
		if err != nil {
			return snapshotProjection{}, err
		}
		digest, err := requiredHex(record.SHA256)
		if err != nil {
			return snapshotProjection{}, err
		}
		sequence, err := signedUint64(record.Sequence)
		if err != nil {
			return snapshotProjection{}, err
		}
		auditRows = append(auditRows, []any{
			sequence, int32(record.SchemaVersion), occurredAt, record.Action, optionalString(record.TenantID), optionalString(record.ProjectID),
			optionalString(record.NodeID), optionalString(record.TaskID), optionalString(record.OperationID), optionalString(record.ArtifactID),
			principalDigest, record.Outcome, previousDigest, digest,
		})
	}
	projection.tables = append(projection.tables, copyTable{name: "audit_records", columns: []string{"sequence", "schema_version", "occurred_at", "action", "tenant_id", "project_id", "node_id", "task_id", "operation_id", "artifact_id", "principal_sha256", "outcome", "previous_sha256", "sha256"}, rows: auditRows})
	return projection, nil
}

func projectComputers(state snapshotState, provisions []cloudplane.NodeProvision) (map[string]*computerProjection, error) {
	if err := cloudplane.ValidateComputerAgentPlacements(provisions); err != nil {
		return nil, err
	}
	computers := make(map[string]*computerProjection)
	explicitScopes := make(map[string]bool)
	registered := state.Nodes
	ensure := func(tenantID, projectID, computerID, agent string, createdAt *time.Time) *computerProjection {
		key := scopeKey(tenantID, projectID) + "\x00" + computerID
		computer := computers[key]
		if computer == nil {
			computer = &computerProjection{tenantID: tenantID, projectID: projectID, id: computerID, agent: agent, createdAt: createdAt, nodes: make(map[string]struct{})}
			computers[key] = computer
		} else if computer.agent != agent && agent != "" {
			return nil
		} else if createdAt != nil && (computer.createdAt == nil || createdAt.Before(*computer.createdAt)) {
			value := *createdAt
			computer.createdAt = &value
		}
		return computer
	}
	for _, provision := range provisions {
		for _, item := range provision.Computers {
			explicitScopes[scopeKey(item.TenantID, item.ProjectID)] = true
			computer := ensure(item.TenantID, item.ProjectID, item.ID, item.Agent, nil)
			if computer == nil {
				return nil, errors.New("cloud control-plane Computer provisions disagree on Agent identity")
			}
			if _, exists := registered[provision.ID]; exists {
				computer.nodes[provision.ID] = struct{}{}
			}
		}
	}
	observe := func(tenantID, projectID, computerID, timestamp string) error {
		createdAt, err := requiredTime(timestamp)
		if err != nil {
			return err
		}
		computer := ensure(tenantID, projectID, computerID, "", &createdAt)
		if computer == nil {
			return errors.New("cloud control-plane observed Computer disagrees with provisioned Agent identity")
		}
		key := scopeKey(tenantID, projectID)
		if explicitScopes[key] {
			return nil
		}
		for _, provision := range provisions {
			if len(provision.Computers) != 0 {
				continue
			}
			for _, scope := range provision.Scopes {
				if scope.TenantID == tenantID && scope.ProjectID == projectID {
					if _, exists := registered[provision.ID]; exists {
						computer.nodes[provision.ID] = struct{}{}
					}
					break
				}
			}
		}
		return nil
	}
	for _, task := range state.Tasks {
		if err := observe(task.TenantID, task.ProjectID, task.ComputerID, task.CreatedAt); err != nil {
			return nil, err
		}
	}
	for _, operation := range state.WorkspaceOperations {
		if err := observe(operation.TenantID, operation.ProjectID, operation.ComputerID, operation.CreatedAt); err != nil {
			return nil, err
		}
	}
	for _, artifact := range state.Artifacts {
		if err := observe(artifact.TenantID, artifact.ProjectID, artifact.ComputerID, artifact.CreatedAt); err != nil {
			return nil, err
		}
	}
	return computers, nil
}

func clearProjectedState(ctx context.Context, transaction pgx.Tx) error {
	for _, table := range []string{"task_outbox", "task_transition_receipts", "audit_records", "artifacts", "workspace_operations", "task_events", "tasks", "agent_sessions", "computer_nodes", "computers", "scope_dispatch", "node_scopes", "nodes"} {
		if _, err := transaction.Exec(ctx, `DELETE FROM zapvm.`+table); err != nil {
			return databaseFailure("clear PostgreSQL "+table, err)
		}
	}
	return nil
}

func enableOwnerBypass(ctx context.Context, transaction pgx.Tx) error {
	var allowed bool
	if err := transaction.QueryRow(ctx, `SELECT set_config('zapvm.bypass_rls', 'on', true) IS NOT NULL AND zapvm.can_bypass_rls()`).Scan(&allowed); err != nil {
		return errors.New("enable PostgreSQL owner-gated RLS bypass")
	}
	if !allowed {
		return errors.New("PostgreSQL role is not authorized to import Control state")
	}
	return nil
}

func readMirrorMetadata(ctx context.Context, transaction pgx.Tx) (mirrorMetadata, bool, error) {
	var metadata mirrorMetadata
	var countsJSON []byte
	err := transaction.QueryRow(ctx, `SELECT snapshot_format_version, source_state_schema_version, source_sha256, database_sha256, row_counts, imported_at FROM zapvm.file_mirror_state WHERE singleton`).Scan(
		&metadata.snapshotFormat, &metadata.stateSchema, &metadata.sourceDigest, &metadata.databaseDigest, &countsJSON, &metadata.importedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return mirrorMetadata{}, false, nil
	}
	if err != nil {
		return mirrorMetadata{}, false, databaseFailure("read PostgreSQL file mirror metadata", err)
	}
	if len(metadata.sourceDigest) != sha256.Size || len(metadata.databaseDigest) != sha256.Size || json.Unmarshal(countsJSON, &metadata.rowCounts) != nil {
		return mirrorMetadata{}, false, errors.New("PostgreSQL file mirror metadata is invalid")
	}
	return metadata, true, nil
}

type digestQuery struct {
	name  string
	query string
}

var databaseDigestQueries = []digestQuery{
	{name: "control_state", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY singleton), '[]'::jsonb)::text FROM zapvm.control_state AS t`},
	{name: "nodes", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb)::text FROM zapvm.nodes AS t`},
	{name: "node_scopes", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY node_id, tenant_id, project_id), '[]'::jsonb)::text FROM zapvm.node_scopes AS t`},
	{name: "computers", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY tenant_id, project_id, computer_id), '[]'::jsonb)::text FROM zapvm.computers AS t`},
	{name: "computer_nodes", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY tenant_id, project_id, computer_id, node_id), '[]'::jsonb)::text FROM zapvm.computer_nodes AS t`},
	{name: "agent_sessions", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY tenant_id, project_id, session_id), '[]'::jsonb)::text FROM zapvm.agent_sessions AS t`},
	{name: "tasks", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb)::text FROM zapvm.tasks AS t`},
	{name: "task_events", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY tenant_id, project_id, task_id, cursor), '[]'::jsonb)::text FROM zapvm.task_events AS t`},
	{name: "workspace_operations", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb)::text FROM zapvm.workspace_operations AS t`},
	{name: "artifacts", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb)::text FROM zapvm.artifacts AS t`},
	{name: "scope_dispatch", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY tenant_id, project_id), '[]'::jsonb)::text FROM zapvm.scope_dispatch AS t`},
	{name: "audit_records", query: `SELECT count(*), COALESCE(jsonb_agg(to_jsonb(t) ORDER BY sequence), '[]'::jsonb)::text FROM zapvm.audit_records AS t`},
}

func databaseStateDigest(ctx context.Context, transaction pgx.Tx) ([]byte, map[string]int64, error) {
	hash := sha256.New()
	counts := make(map[string]int64, len(databaseDigestQueries))
	for _, item := range databaseDigestQueries {
		var count int64
		var document string
		if err := transaction.QueryRow(ctx, item.query).Scan(&count, &document); err != nil {
			return nil, nil, databaseFailure("digest PostgreSQL "+item.name, err)
		}
		counts[item.name] = count
		_, _ = hash.Write([]byte(item.name))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(document))
		_, _ = hash.Write([]byte{0})
	}
	return hash.Sum(nil), counts, nil
}

func hasTrackedRows(counts map[string]int64) bool {
	for table, count := range counts {
		if table != "control_state" && count != 0 {
			return true
		}
	}
	return false
}

func equalRowCounts(left, right map[string]int64) bool {
	if len(left) != len(right) {
		return false
	}
	for table, count := range left {
		if right[table] != count {
			return false
		}
	}
	return true
}

func reportFromMetadata(changed bool, metadata mirrorMetadata) FileImportReport {
	counts := make(map[string]int64, len(metadata.rowCounts))
	for table, count := range metadata.rowCounts {
		counts[table] = count
	}
	return FileImportReport{
		Changed: changed, SnapshotFormat: metadata.snapshotFormat, StateSchema: metadata.stateSchema,
		SourceSHA256: hex.EncodeToString(metadata.sourceDigest), DatabaseSHA256: hex.EncodeToString(metadata.databaseDigest),
		RowCounts: counts, ImportedAt: metadata.importedAt,
	}
}

func rollbackBounded(transaction pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	_ = transaction.Rollback(ctx)
}

func databaseFailure(action string, err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return fmt.Errorf("%s: PostgreSQL code %s", action, postgresError.Code)
	}
	return errors.New(action)
}

func requiredHex(value string) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return nil, errors.New("cloud control-plane snapshot contains an invalid digest")
	}
	return decoded, nil
}

func optionalHex(value string) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	return requiredHex(value)
}

func requiredTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, errors.New("cloud control-plane snapshot contains an invalid timestamp")
	}
	return parsed.UTC(), nil
}

func optionalTime(value string) (any, error) {
	if value == "" {
		return nil, nil
	}
	return requiredTime(value)
}

func optionalString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func optionalBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func optionalJSON(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func optionalPositiveInt64(value uint64) (any, error) {
	if value == 0 {
		return nil, nil
	}
	return signedUint64(value)
}

func signedUint64(value uint64) (int64, error) {
	if value > math.MaxInt64 {
		return 0, errors.New("cloud control-plane snapshot integer exceeds PostgreSQL bigint")
	}
	return int64(value), nil
}

func optionalNonnegativeInt(value int) any {
	if value == 0 {
		return nil
	}
	return int32(value)
}

func optionalBool(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullablePath(operation cloudplane.WorkspaceOperation) any {
	if operation.Kind == cloudplane.WorkspaceOperationGitPush {
		return nil
	}
	return operation.Path
}

func scopeKey(tenantID, projectID string) string { return tenantID + "\x00" + projectID }

func sameScopes(left, right []cloudplane.Scope) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[string]struct{}, len(left))
	for _, scope := range left {
		seen[scopeKey(scope.TenantID, scope.ProjectID)] = struct{}{}
	}
	if len(seen) != len(left) {
		return false
	}
	for _, scope := range right {
		if _, exists := seen[scopeKey(scope.TenantID, scope.ProjectID)]; !exists {
			return false
		}
	}
	return true
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func terminalTaskState(state string) bool {
	return state == cloudplane.TaskSucceeded || state == cloudplane.TaskFailed || state == cloudplane.TaskCanceled
}

func joinedRowKey(row []any) string {
	parts := make([]string, len(row))
	for index, value := range row {
		parts[index] = fmt.Sprint(value)
	}
	return strings.Join(parts, "\x00")
}

func sortedNodeIDs(values map[string]cloudplane.Node) []string {
	result := make([]string, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	sort.Strings(result)
	return result
}

func sortedTaskIDs(values map[string]cloudplane.Task) []string {
	result := make([]string, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	sort.Strings(result)
	return result
}

func sortedOperationIDs(values map[string]cloudplane.WorkspaceOperation) []string {
	result := make([]string, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	sort.Strings(result)
	return result
}

func sortedArtifactIDs(values map[string]cloudplane.Artifact) []string {
	result := make([]string, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	sort.Strings(result)
	return result
}
