package controlpostgres

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
	"zapvm/internal/credential"
	"zapvm/internal/credentialkms"
)

type credentialAuditInput struct {
	action, credentialID, capabilityID, taskID, nodeID, nodeGeneration, principal, outcome string
	credentialVersion                                                                      uint64
	scope                                                                                  cloudplane.Scope
}

type credentialAuditHash struct {
	SchemaVersion     int    `json:"schema_version"`
	Sequence          uint64 `json:"sequence"`
	OccurredAt        string `json:"occurred_at"`
	Action            string `json:"action"`
	TenantID          string `json:"tenant_id"`
	ProjectID         string `json:"project_id"`
	CredentialID      string `json:"credential_id,omitempty"`
	CredentialVersion uint64 `json:"credential_version,omitempty"`
	CapabilityID      string `json:"capability_id,omitempty"`
	TaskID            string `json:"task_id,omitempty"`
	NodeID            string `json:"node_id,omitempty"`
	NodeGeneration    string `json:"node_generation,omitempty"`
	PrincipalSHA256   string `json:"principal_sha256"`
	Outcome           string `json:"outcome"`
	PreviousSHA256    string `json:"previous_sha256,omitempty"`
}

func (queue *Queue) PutCredential(ctx context.Context, principal string, scope cloudplane.Scope, id string, value []byte) (cloudplane.CredentialDescriptor, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.CredentialDescriptor{}, err
	}
	if queue.credentialBroker == nil {
		return cloudplane.CredentialDescriptor{}, cloudplane.ErrUnavailable
	}
	if !cloudplane.ValidPrincipal(principal) || scope.Validate() != nil {
		return cloudplane.CredentialDescriptor{}, cloudplane.ErrUnauthorized
	}
	if !credential.ValidID(id) || len(value) == 0 || len(value) > credential.MaxValueSize {
		return cloudplane.CredentialDescriptor{}, errors.New("Credential ID or value size is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.CredentialDescriptor{}, err
	}
	defer rollbackBounded(transaction)
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "credential|"+scope.TenantID+"|"+scope.ProjectID+"|"+id); err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("lock PostgreSQL Credential", err)
	}
	var previous int64
	if err := transaction.QueryRow(ctx, `SELECT COALESCE(max(version),0) FROM zapvm.credential_envelopes WHERE tenant_id=$1 AND project_id=$2 AND credential_id=$3`, scope.TenantID, scope.ProjectID, id).Scan(&previous); err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("inspect PostgreSQL Credential version", err)
	}
	version := uint64(previous + 1)
	envelope, err := queue.credentialBroker.Seal(ctx, credentialkms.Binding{TenantID: scope.TenantID, ProjectID: scope.ProjectID, CredentialID: id, Version: version}, value)
	if err != nil {
		return cloudplane.CredentialDescriptor{}, cloudplane.ErrUnavailable
	}
	defer destroyEnvelope(&envelope)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.credential_envelopes SET state='disabled',updated_at=$1 WHERE tenant_id=$2 AND project_id=$3 AND credential_id=$4 AND state='active'`, now, scope.TenantID, scope.ProjectID, id); err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("disable previous PostgreSQL Credential", err)
	}
	principalDigest := sha256.Sum256([]byte(principal))
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.credential_envelopes
    (tenant_id,project_id,credential_id,version,state,envelope_schema,algorithm,kms_provider,kms_key_id,kms_key_version,wrapped_data_key,nonce,ciphertext,aad_sha256,created_by_sha256,created_at,updated_at)
VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
		scope.TenantID, scope.ProjectID, id, int64(version), envelope.SchemaVersion, envelope.Algorithm,
		envelope.WrappedKey.Provider, envelope.WrappedKey.KeyID, envelope.WrappedKey.KeyVersion, envelope.WrappedKey.Ciphertext,
		envelope.Nonce, envelope.Ciphertext, envelope.AADSHA256, principalDigest[:], now); err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("insert PostgreSQL Credential envelope", err)
	}
	action := "credential_create"
	if previous != 0 {
		action = "credential_rotate"
	}
	if err := appendCredentialAudit(ctx, transaction, now, credentialAuditInput{
		action: action, scope: scope, credentialID: id, credentialVersion: version, principal: principal, outcome: "active",
	}); err != nil {
		return cloudplane.CredentialDescriptor{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("commit PostgreSQL Credential", err)
	}
	return cloudplane.CredentialDescriptor{ID: id, Version: version, State: "active", CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano)}, nil
}

func (queue *Queue) ListCredentials(ctx context.Context, scope cloudplane.Scope) ([]cloudplane.CredentialDescriptor, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if queue.credentialBroker == nil {
		return nil, cloudplane.ErrUnavailable
	}
	if scope.Validate() != nil {
		return nil, cloudplane.ErrUnauthorized
	}
	rows, err := queue.migrator.pool.Query(ctx, `
SELECT DISTINCT ON (credential_id) credential_id,version,state,created_at,updated_at
FROM zapvm.credential_envelopes WHERE tenant_id=$1 AND project_id=$2
ORDER BY credential_id,version DESC`, scope.TenantID, scope.ProjectID)
	if err != nil {
		return nil, databaseFailure("list PostgreSQL Credentials", err)
	}
	defer rows.Close()
	result := make([]cloudplane.CredentialDescriptor, 0)
	for rows.Next() {
		var descriptor cloudplane.CredentialDescriptor
		var created, updated time.Time
		if err := rows.Scan(&descriptor.ID, &descriptor.Version, &descriptor.State, &created, &updated); err != nil {
			return nil, errors.New("decode PostgreSQL Credential descriptor")
		}
		descriptor.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		descriptor.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		result = append(result, descriptor)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL Credential descriptors")
	}
	return result, nil
}

func (queue *Queue) RevokeCredential(ctx context.Context, principal string, scope cloudplane.Scope, id string) (cloudplane.CredentialDescriptor, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.CredentialDescriptor{}, err
	}
	if queue.credentialBroker == nil {
		return cloudplane.CredentialDescriptor{}, cloudplane.ErrUnavailable
	}
	if !cloudplane.ValidPrincipal(principal) || scope.Validate() != nil {
		return cloudplane.CredentialDescriptor{}, cloudplane.ErrUnauthorized
	}
	if !credential.ValidID(id) {
		return cloudplane.CredentialDescriptor{}, errors.New("Credential ID is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.CredentialDescriptor{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	var version uint64
	var created time.Time
	if err := transaction.QueryRow(ctx, `SELECT version,created_at FROM zapvm.credential_envelopes WHERE tenant_id=$1 AND project_id=$2 AND credential_id=$3 ORDER BY version DESC LIMIT 1 FOR UPDATE`, scope.TenantID, scope.ProjectID, id).Scan(&version, &created); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.CredentialDescriptor{}, cloudplane.ErrNotFound
	} else if err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("lock PostgreSQL Credential revocation", err)
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.credential_envelopes SET state='revoked',updated_at=$1,revoked_at=COALESCE(revoked_at,$1) WHERE tenant_id=$2 AND project_id=$3 AND credential_id=$4 AND state<>'revoked'`, now, scope.TenantID, scope.ProjectID, id); err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("revoke PostgreSQL Credential", err)
	}
	if err := appendCredentialAudit(ctx, transaction, now, credentialAuditInput{
		action: "credential_revoke", scope: scope, credentialID: id, credentialVersion: version, principal: principal, outcome: "revoked",
	}); err != nil {
		return cloudplane.CredentialDescriptor{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.CredentialDescriptor{}, databaseFailure("commit PostgreSQL Credential revocation", err)
	}
	return cloudplane.CredentialDescriptor{ID: id, Version: version, State: "revoked", CreatedAt: created.UTC().Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano)}, nil
}

func (queue *Queue) issueCredentialCapability(ctx context.Context, transaction pgx.Tx, task cloudplane.Task, nodeID, generation string, now time.Time) (*cloudplane.CredentialCapability, error) {
	if len(task.CredentialIDs) == 0 || queue.credentialBroker == nil {
		return nil, nil
	}
	versions := make(map[string]uint64, len(task.CredentialIDs))
	rows, err := transaction.Query(ctx, `SELECT credential_id,version FROM zapvm.credential_envelopes WHERE tenant_id=$1 AND project_id=$2 AND state='active' AND credential_id=ANY($3) ORDER BY credential_id`, task.TenantID, task.ProjectID, task.CredentialIDs)
	if err != nil {
		return nil, databaseFailure("resolve PostgreSQL Credential versions", err)
	}
	for rows.Next() {
		var id string
		var version uint64
		if err := rows.Scan(&id, &version); err != nil {
			rows.Close()
			return nil, errors.New("decode PostgreSQL Credential version")
		}
		versions[id] = version
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(versions) != len(task.CredentialIDs) {
		return nil, cloudplane.ErrUnavailable
	}
	idBytes := make([]byte, 18)
	secret := make([]byte, 32)
	if _, err := io.ReadFull(queue.random, idBytes); err != nil {
		credential.ZeroBytes(secret)
		return nil, errors.New("generate Credential capability ID")
	}
	if _, err := io.ReadFull(queue.random, secret); err != nil {
		credential.ZeroBytes(secret)
		return nil, errors.New("generate Credential capability secret")
	}
	capability := &cloudplane.CredentialCapability{ID: "credcap_" + base64.RawURLEncoding.EncodeToString(idBytes), Secret: secret}
	failed := true
	defer func() {
		if failed {
			capability.Destroy()
		}
	}()
	expiresAt := now.Add(queue.credentialCapabilityTTL)
	if leaseExpiry, err := time.Parse(time.RFC3339Nano, task.LeaseExpiresAt); err == nil && leaseExpiry.Before(expiresAt) {
		expiresAt = leaseExpiry
	}
	if !expiresAt.After(now) {
		return nil, cloudplane.ErrFenced
	}
	capability.ExpiresAt = expiresAt.UTC().Format(time.RFC3339Nano)
	secretDigest := sha256.Sum256(secret)
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.credential_capabilities
    (capability_id,secret_sha256,tenant_id,project_id,task_id,node_id,node_generation,state,issued_at,expires_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9)`, capability.ID, secretDigest[:], task.TenantID, task.ProjectID, task.ID, nodeID, generation, now, expiresAt); err != nil {
		return nil, databaseFailure("insert PostgreSQL Credential capability", err)
	}
	ids := append([]string(nil), task.CredentialIDs...)
	sort.Strings(ids)
	for _, id := range ids {
		if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.credential_capability_items (tenant_id,project_id,capability_id,credential_id,credential_version) VALUES ($1,$2,$3,$4,$5)`, task.TenantID, task.ProjectID, capability.ID, id, int64(versions[id])); err != nil {
			return nil, databaseFailure("bind PostgreSQL Credential capability item", err)
		}
	}
	if err := appendCredentialAudit(ctx, transaction, now, credentialAuditInput{
		action: "capability_issue", scope: task.Scope(), capabilityID: capability.ID, taskID: task.ID,
		nodeID: nodeID, nodeGeneration: generation, principal: nodePrincipal(nodeID, generation), outcome: "issued",
	}); err != nil {
		return nil, err
	}
	failed = false
	return capability, nil
}

func (queue *Queue) RedeemCredentialCapability(ctx context.Context, nodeID, generation, taskID, leaseToken string, capability cloudplane.CredentialCapability) (cloudplane.CredentialBundle, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.CredentialBundle{}, err
	}
	if queue.credentialBroker == nil {
		return cloudplane.CredentialBundle{}, cloudplane.ErrUnavailable
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || !queueIDPattern.MatchString(taskID) ||
		!queueIDPattern.MatchString(capability.ID) || len(capability.Secret) != 32 || validateQueueToken(leaseToken) != nil {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.CredentialBundle{}, err
	}
	defer rollbackBounded(transaction)
	var tenantID, projectID, capabilityTask, capabilityNode, capabilityGeneration, state string
	var secretDigest []byte
	var expiresAt time.Time
	err = transaction.QueryRow(ctx, `
SELECT tenant_id,project_id,task_id,node_id,node_generation,state,secret_sha256,expires_at
FROM zapvm.credential_capabilities WHERE capability_id=$1 FOR UPDATE`, capability.ID).Scan(
		&tenantID, &projectID, &capabilityTask, &capabilityNode, &capabilityGeneration, &state, &secretDigest, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	if err != nil {
		return cloudplane.CredentialBundle{}, databaseFailure("lock PostgreSQL Credential capability", err)
	}
	candidateDigest := sha256.Sum256(capability.Secret)
	if capabilityTask != taskID || capabilityNode != nodeID || capabilityGeneration != generation || subtle.ConstantTimeCompare(secretDigest, candidateDigest[:]) != 1 {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	var nodeState string
	var nodeHeartbeat time.Time
	err = transaction.QueryRow(ctx, `SELECT state,last_heartbeat FROM zapvm.nodes WHERE id=$1 AND generation=$2 FOR SHARE`, nodeID, generation).Scan(&nodeState, &nodeHeartbeat)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (nodeState == cloudplane.NodeOffline || now.Sub(nodeHeartbeat) > queue.heartbeatTTL)) {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	if err != nil {
		return cloudplane.CredentialBundle{}, databaseFailure("verify PostgreSQL Credential Node generation", err)
	}
	var taskState, taskNode, taskGeneration string
	var leaseDigest []byte
	var leaseExpires time.Time
	err = transaction.QueryRow(ctx, `SELECT state,node_id,node_generation,lease_token_hash,lease_expires_at FROM zapvm.tasks WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE`, taskID, tenantID, projectID).Scan(&taskState, &taskNode, &taskGeneration, &leaseDigest, &leaseExpires)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	if err != nil {
		return cloudplane.CredentialBundle{}, databaseFailure("lock PostgreSQL Credential Task", err)
	}
	leaseCandidate := sha256.Sum256([]byte(leaseToken))
	if state == "issued" && !expiresAt.After(now) {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.credential_capabilities SET state='expired' WHERE capability_id=$1 AND state='issued'`, capability.ID); err != nil {
			return cloudplane.CredentialBundle{}, databaseFailure("expire PostgreSQL Credential capability", err)
		}
		if err := appendCredentialAudit(ctx, transaction, now, credentialAuditInput{
			action: "capability_expire", scope: cloudplane.Scope{TenantID: tenantID, ProjectID: projectID}, capabilityID: capability.ID,
			taskID: taskID, nodeID: nodeID, nodeGeneration: generation, principal: nodePrincipal(nodeID, generation), outcome: "expired",
		}); err != nil {
			return cloudplane.CredentialBundle{}, err
		}
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.CredentialBundle{}, databaseFailure("commit PostgreSQL Credential expiration", err)
		}
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	if state != "issued" || taskState != cloudplane.TaskRunning || taskNode != nodeID || taskGeneration != generation ||
		!leaseExpires.After(now) || subtle.ConstantTimeCompare(leaseDigest, leaseCandidate[:]) != 1 {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	rows, err := transaction.Query(ctx, `
SELECT item.credential_id,item.credential_version,envelope.state,envelope.envelope_schema,envelope.algorithm,
       envelope.kms_provider,envelope.kms_key_id,envelope.kms_key_version,envelope.wrapped_data_key,envelope.nonce,envelope.ciphertext,envelope.aad_sha256
FROM zapvm.credential_capability_items AS item
JOIN zapvm.credential_envelopes AS envelope
  ON envelope.tenant_id=item.tenant_id AND envelope.project_id=item.project_id
 AND envelope.credential_id=item.credential_id AND envelope.version=item.credential_version
WHERE item.tenant_id=$1 AND item.project_id=$2 AND item.capability_id=$3
ORDER BY item.credential_id FOR SHARE OF envelope`, tenantID, projectID, capability.ID)
	if err != nil {
		return cloudplane.CredentialBundle{}, databaseFailure("load PostgreSQL Credential capability items", err)
	}
	values := make(map[string][]byte)
	failed := true
	defer func() {
		if failed {
			credential.ZeroValues(values)
		}
	}()
	for rows.Next() {
		var id, envelopeState string
		var version uint64
		var envelope credentialkms.Envelope
		if err := rows.Scan(&id, &version, &envelopeState, &envelope.SchemaVersion, &envelope.Algorithm,
			&envelope.WrappedKey.Provider, &envelope.WrappedKey.KeyID, &envelope.WrappedKey.KeyVersion, &envelope.WrappedKey.Ciphertext,
			&envelope.Nonce, &envelope.Ciphertext, &envelope.AADSHA256); err != nil {
			rows.Close()
			return cloudplane.CredentialBundle{}, errors.New("decode PostgreSQL Credential envelope")
		}
		if envelopeState == "revoked" {
			rows.Close()
			return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
		}
		value, err := queue.credentialBroker.Open(ctx, credentialkms.Binding{TenantID: tenantID, ProjectID: projectID, CredentialID: id, Version: version}, envelope)
		destroyEnvelope(&envelope)
		if err != nil {
			rows.Close()
			return cloudplane.CredentialBundle{}, cloudplane.ErrUnavailable
		}
		values[id] = value
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return cloudplane.CredentialBundle{}, errors.New("read PostgreSQL Credential envelopes")
	}
	var requested []string
	if err := transaction.QueryRow(ctx, `SELECT credential_ids FROM zapvm.tasks WHERE id=$1`, taskID).Scan(&requested); err != nil || len(requested) != len(values) {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	for _, id := range requested {
		if _, ok := values[id]; !ok {
			return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
		}
	}
	command, err := transaction.Exec(ctx, `UPDATE zapvm.credential_capabilities SET state='redeemed',redeemed_at=$1 WHERE capability_id=$2 AND state='issued'`, now, capability.ID)
	if err != nil {
		return cloudplane.CredentialBundle{}, databaseFailure("redeem PostgreSQL Credential capability", err)
	}
	if command.RowsAffected() != 1 {
		return cloudplane.CredentialBundle{}, cloudplane.ErrFenced
	}
	if err := appendCredentialAudit(ctx, transaction, now, credentialAuditInput{
		action: "capability_redeem", scope: cloudplane.Scope{TenantID: tenantID, ProjectID: projectID}, capabilityID: capability.ID,
		taskID: taskID, nodeID: nodeID, nodeGeneration: generation, principal: nodePrincipal(nodeID, generation), outcome: "redeemed",
	}); err != nil {
		return cloudplane.CredentialBundle{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.CredentialBundle{}, databaseFailure("commit PostgreSQL Credential redemption", err)
	}
	failed = false
	return cloudplane.CredentialBundle{Values: values}, nil
}

func appendCredentialAudit(ctx context.Context, transaction pgx.Tx, now time.Time, input credentialAuditInput) error {
	principalDigest := sha256.Sum256([]byte(input.principal))
	var sequence int64
	if err := transaction.QueryRow(ctx, `SELECT credential_audit_sequence FROM zapvm.control_state WHERE singleton FOR UPDATE`).Scan(&sequence); err != nil {
		return databaseFailure("lock PostgreSQL Credential audit sequence", err)
	}
	var previous []byte
	err := transaction.QueryRow(ctx, `SELECT sha256 FROM zapvm.credential_access_audit WHERE sequence=$1`, sequence).Scan(&previous)
	if sequence == 0 && errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	if err != nil || (sequence != 0 && len(previous) != sha256.Size) {
		return errors.New("PostgreSQL Credential audit chain is incomplete")
	}
	record := credentialAuditHash{
		SchemaVersion: 1, Sequence: uint64(sequence + 1), OccurredAt: now.UTC().Format(time.RFC3339Nano), Action: input.action,
		TenantID: input.scope.TenantID, ProjectID: input.scope.ProjectID, CredentialID: input.credentialID,
		CredentialVersion: input.credentialVersion, CapabilityID: input.capabilityID, TaskID: input.taskID,
		NodeID: input.nodeID, NodeGeneration: input.nodeGeneration, PrincipalSHA256: hex.EncodeToString(principalDigest[:]), Outcome: input.outcome,
	}
	if len(previous) != 0 {
		record.PreviousSHA256 = hex.EncodeToString(previous)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return errors.New("encode PostgreSQL Credential audit record")
	}
	digest := sha256.Sum256(encoded)
	credential.ZeroBytes(encoded)
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.control_state SET credential_audit_sequence=$1,updated_at=$2 WHERE singleton`, sequence+1, now); err != nil {
		return databaseFailure("advance PostgreSQL Credential audit sequence", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.credential_access_audit
    (sequence,schema_version,occurred_at,action,tenant_id,project_id,credential_id,credential_version,capability_id,task_id,node_id,node_generation,principal_sha256,outcome,previous_sha256,sha256)
VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, sequence+1, now, input.action,
		input.scope.TenantID, input.scope.ProjectID, optionalString(input.credentialID), optionalInt64(input.credentialVersion),
		optionalString(input.capabilityID), optionalString(input.taskID), optionalString(input.nodeID), optionalString(input.nodeGeneration),
		principalDigest[:], input.outcome, previous, digest[:]); err != nil {
		return databaseFailure("insert PostgreSQL Credential audit record", err)
	}
	return nil
}

func (queue *Queue) expireCredentialCapabilities(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	rows, err := transaction.Query(ctx, `
SELECT capability_id,tenant_id,project_id,task_id,node_id,node_generation
FROM zapvm.credential_capabilities
WHERE state='issued' AND expires_at<=$1
ORDER BY expires_at,capability_id
FOR UPDATE SKIP LOCKED
LIMIT 1000`, now)
	if err != nil {
		return databaseFailure("lock expired PostgreSQL Credential capabilities", err)
	}
	type expiredCapability struct {
		id, tenantID, projectID, taskID, nodeID, generation string
	}
	expired := make([]expiredCapability, 0)
	for rows.Next() {
		var capability expiredCapability
		if err := rows.Scan(&capability.id, &capability.tenantID, &capability.projectID, &capability.taskID, &capability.nodeID, &capability.generation); err != nil {
			rows.Close()
			return errors.New("decode expired PostgreSQL Credential capability")
		}
		expired = append(expired, capability)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read expired PostgreSQL Credential capabilities")
	}
	for _, capability := range expired {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.credential_capabilities SET state='expired' WHERE capability_id=$1 AND state='issued'`, capability.id); err != nil {
			return databaseFailure("expire PostgreSQL Credential capability", err)
		}
		if err := appendCredentialAudit(ctx, transaction, now, credentialAuditInput{
			action: "capability_expire", scope: cloudplane.Scope{TenantID: capability.tenantID, ProjectID: capability.projectID},
			capabilityID: capability.id, taskID: capability.taskID, nodeID: capability.nodeID, nodeGeneration: capability.generation,
			principal: nodePrincipal(capability.nodeID, capability.generation), outcome: "expired",
		}); err != nil {
			return err
		}
	}
	return nil
}

func (queue *Queue) revokeTaskCredentialCapabilities(ctx context.Context, transaction pgx.Tx, task cloudplane.Task, now time.Time) error {
	rows, err := transaction.Query(ctx, `SELECT capability_id,node_id,node_generation FROM zapvm.credential_capabilities WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND state='issued' ORDER BY capability_id FOR UPDATE`, task.TenantID, task.ProjectID, task.ID)
	if err != nil {
		return databaseFailure("lock terminal PostgreSQL Credential capabilities", err)
	}
	type capabilityAuthority struct{ id, nodeID, generation string }
	capabilities := make([]capabilityAuthority, 0)
	for rows.Next() {
		var capability capabilityAuthority
		if err := rows.Scan(&capability.id, &capability.nodeID, &capability.generation); err != nil {
			rows.Close()
			return errors.New("decode terminal PostgreSQL Credential capability")
		}
		capabilities = append(capabilities, capability)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read terminal PostgreSQL Credential capabilities")
	}
	for _, capability := range capabilities {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.credential_capabilities SET state='revoked',revoked_at=$1 WHERE capability_id=$2 AND state='issued'`, now, capability.id); err != nil {
			return databaseFailure("revoke terminal PostgreSQL Credential capability", err)
		}
		if err := appendCredentialAudit(ctx, transaction, now, credentialAuditInput{
			action: "capability_revoke", scope: task.Scope(), capabilityID: capability.id, taskID: task.ID,
			nodeID: capability.nodeID, nodeGeneration: capability.generation, principal: nodePrincipal(capability.nodeID, capability.generation), outcome: task.State,
		}); err != nil {
			return err
		}
	}
	return nil
}

func optionalInt64(value uint64) any {
	if value == 0 {
		return nil
	}
	return int64(value)
}

func nodePrincipal(nodeID, generation string) string {
	return "node\x00" + nodeID + "\x00" + generation
}

func destroyEnvelope(envelope *credentialkms.Envelope) {
	if envelope == nil {
		return
	}
	credential.ZeroBytes(envelope.WrappedKey.Ciphertext)
	credential.ZeroBytes(envelope.Nonce)
	credential.ZeroBytes(envelope.Ciphertext)
	credential.ZeroBytes(envelope.AADSHA256)
}
