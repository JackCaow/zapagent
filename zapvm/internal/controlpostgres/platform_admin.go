package controlpostgres

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"zapvm/internal/cloudplane"
	"zapvm/internal/computer"
	"zapvm/internal/credential"
)

func (queue *Queue) EnsureWorkspaceOwner(ctx context.Context, principal string, scope cloudplane.Scope, userID, displayName, email string) (cloudplane.WorkspaceMember, error) {
	member := cloudplane.WorkspaceMember{UserID: userID, DisplayName: displayName, Email: email, Role: cloudplane.RoleOwner, Status: "active"}
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || cloudplane.ValidateWorkspaceMember(member) != nil {
		return cloudplane.WorkspaceMember{}, cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceMember{}, err
	}
	defer rollbackBounded(tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "workspace-owner|"+scope.TenantID+"|"+scope.ProjectID); err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("lock Workspace owner bootstrap", err)
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2`, scope.TenantID, scope.ProjectID).Scan(&count); err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("count Workspace members", err)
	}
	if count == 0 {
		now := queue.now().UTC().Truncate(time.Microsecond)
		if _, err := tx.Exec(ctx, `INSERT INTO zapvm.workspace_members (tenant_id,project_id,user_id,display_name,email,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'owner','active',$6,$6)`, scope.TenantID, scope.ProjectID, userID, displayName, email, now); err != nil {
			return cloudplane.WorkspaceMember{}, databaseFailure("bootstrap Workspace owner", err)
		}
		if _, err := appendAudit(ctx, tx, now, auditInput{action: "member_create", scope: scope, principal: principal, outcome: "owner"}); err != nil {
			return cloudplane.WorkspaceMember{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("commit Workspace owner bootstrap", err)
	}
	return queue.ResolveWorkspaceMember(ctx, scope, userID)
}

func (queue *Queue) ResolveWorkspaceMember(ctx context.Context, scope cloudplane.Scope, userID string) (cloudplane.WorkspaceMember, error) {
	if queue == nil || ctx == nil || scope.Validate() != nil || !queueNamePattern.MatchString(userID) {
		return cloudplane.WorkspaceMember{}, cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceMember{}, err
	}
	defer rollbackBounded(tx)
	var member cloudplane.WorkspaceMember
	var created, updated time.Time
	err = tx.QueryRow(ctx, `SELECT user_id,display_name,email,role,status,created_at,updated_at FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3`, scope.TenantID, scope.ProjectID, userID).Scan(&member.UserID, &member.DisplayName, &member.Email, &member.Role, &member.Status, &created, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceMember{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("resolve Workspace member", err)
	}
	member.CreatedAt, member.UpdatedAt = platformTime(created), platformTime(updated)
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("commit Workspace member resolution", err)
	}
	return member, nil
}

func (queue *Queue) ListWorkspaceMembers(ctx context.Context, scope cloudplane.Scope) ([]cloudplane.WorkspaceMember, error) {
	if queue == nil || ctx == nil || scope.Validate() != nil {
		return nil, cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(tx)
	rows, err := tx.Query(ctx, `SELECT user_id,display_name,email,role,status,created_at,updated_at FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2 ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'operator' THEN 3 WHEN 'member' THEN 4 ELSE 5 END,user_id`, scope.TenantID, scope.ProjectID)
	if err != nil {
		return nil, databaseFailure("list Workspace members", err)
	}
	defer rows.Close()
	result := []cloudplane.WorkspaceMember{}
	for rows.Next() {
		var item cloudplane.WorkspaceMember
		var created, updated time.Time
		if rows.Scan(&item.UserID, &item.DisplayName, &item.Email, &item.Role, &item.Status, &created, &updated) != nil {
			return nil, errors.New("decode Workspace member")
		}
		item.CreatedAt, item.UpdatedAt = platformTime(created), platformTime(updated)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, databaseFailure("commit Workspace member list", err)
	}
	return result, nil
}

func (queue *Queue) PutWorkspaceMember(ctx context.Context, principal string, scope cloudplane.Scope, member cloudplane.WorkspaceMember) (cloudplane.WorkspaceMember, error) {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || cloudplane.ValidateWorkspaceMember(member) != nil {
		return cloudplane.WorkspaceMember{}, cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceMember{}, err
	}
	defer rollbackBounded(tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "workspace-owner|"+scope.TenantID+"|"+scope.ProjectID); err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("lock Workspace owner update", err)
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	var existingRole, existingStatus string
	err = tx.QueryRow(ctx, `SELECT role,status FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE`, scope.TenantID, scope.ProjectID, member.UserID).Scan(&existingRole, &existingStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceMember{}, databaseFailure("lock Workspace member update", err)
	}
	if err == nil && existingRole == cloudplane.RoleOwner && existingStatus == "active" && (member.Role != cloudplane.RoleOwner || member.Status != "active") {
		var otherOwners int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2 AND role='owner' AND status='active' AND user_id<>$3`, scope.TenantID, scope.ProjectID, member.UserID).Scan(&otherOwners); err != nil {
			return cloudplane.WorkspaceMember{}, databaseFailure("count alternate Workspace owners", err)
		}
		if otherOwners == 0 {
			return cloudplane.WorkspaceMember{}, cloudplane.ErrConflict
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO zapvm.workspace_members (tenant_id,project_id,user_id,display_name,email,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (tenant_id,project_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,email=EXCLUDED.email,role=EXCLUDED.role,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`, scope.TenantID, scope.ProjectID, member.UserID, member.DisplayName, member.Email, member.Role, member.Status, now); err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("upsert Workspace member", err)
	}
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "member_upsert", scope: scope, principal: principal, outcome: member.Role}); err != nil {
		return cloudplane.WorkspaceMember{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.WorkspaceMember{}, databaseFailure("commit Workspace member", err)
	}
	return queue.ResolveWorkspaceMember(ctx, scope, member.UserID)
}

func (queue *Queue) DeleteWorkspaceMember(ctx context.Context, principal string, scope cloudplane.Scope, userID string) error {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || !queueNamePattern.MatchString(userID) {
		return cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "workspace-owner|"+scope.TenantID+"|"+scope.ProjectID); err != nil {
		return databaseFailure("lock Workspace owner deletion", err)
	}
	var role, status string
	if err := tx.QueryRow(ctx, `SELECT role,status FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE`, scope.TenantID, scope.ProjectID, userID).Scan(&role, &status); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ErrNotFound
	} else if err != nil {
		return databaseFailure("lock Workspace member", err)
	}
	if role == cloudplane.RoleOwner && status == "active" {
		var owners int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2 AND role='owner' AND status='active'`, scope.TenantID, scope.ProjectID).Scan(&owners); err != nil {
			return databaseFailure("count Workspace owners", err)
		}
		if owners <= 1 {
			return cloudplane.ErrConflict
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM zapvm.workspace_members WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3`, scope.TenantID, scope.ProjectID, userID); err != nil {
		return databaseFailure("delete Workspace member", err)
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "member_delete", scope: scope, principal: principal, outcome: role}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (queue *Queue) ListHostPools(ctx context.Context, scope cloudplane.Scope) ([]cloudplane.HostPool, error) {
	if queue == nil || ctx == nil || scope.Validate() != nil {
		return nil, cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(tx)
	rows, err := tx.Query(ctx, `SELECT p.pool_id,p.display_name,p.region,p.enabled,p.max_computers,p.labels,p.created_at,p.updated_at,COALESCE(array_agg(n.node_id ORDER BY n.node_id) FILTER (WHERE n.node_id IS NOT NULL),'{}') FROM zapvm.host_pools p LEFT JOIN zapvm.host_pool_nodes n USING (tenant_id,project_id,pool_id) WHERE p.tenant_id=$1 AND p.project_id=$2 GROUP BY p.tenant_id,p.project_id,p.pool_id ORDER BY p.pool_id`, scope.TenantID, scope.ProjectID)
	if err != nil {
		return nil, databaseFailure("list Host Pools", err)
	}
	defer rows.Close()
	result := []cloudplane.HostPool{}
	for rows.Next() {
		var item cloudplane.HostPool
		var labels []byte
		var created, updated time.Time
		if err := rows.Scan(&item.ID, &item.DisplayName, &item.Region, &item.Enabled, &item.MaxComputers, &labels, &created, &updated, &item.NodeIDs); err != nil {
			return nil, errors.New("decode Host Pool")
		}
		if json.Unmarshal(labels, &item.Labels) != nil {
			return nil, errors.New("decode Host Pool labels")
		}
		item.CreatedAt, item.UpdatedAt = platformTime(created), platformTime(updated)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, databaseFailure("commit Host Pool list", err)
	}
	return result, nil
}

func (queue *Queue) PutHostPool(ctx context.Context, principal string, scope cloudplane.Scope, pool cloudplane.HostPool) (cloudplane.HostPool, error) {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || !queueIDPattern.MatchString(pool.ID) || strings.TrimSpace(pool.DisplayName) == "" || pool.MaxComputers < 1 || pool.MaxComputers > 4096 {
		return cloudplane.HostPool{}, cloudplane.ErrUnauthorized
	}
	if pool.Labels == nil {
		pool.Labels = map[string]string{}
	}
	labels, err := json.Marshal(pool.Labels)
	if err != nil || len(labels) > 64<<10 {
		return cloudplane.HostPool{}, errors.New("Host Pool labels are invalid")
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.HostPool{}, err
	}
	defer rollbackBounded(tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "computer-create|"+scope.TenantID+"|"+scope.ProjectID); err != nil {
		return cloudplane.HostPool{}, databaseFailure("lock Host Pool capacity", err)
	}
	var currentComputers int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM zapvm.computer_profiles WHERE tenant_id=$1 AND project_id=$2 AND pool_id=$3`, scope.TenantID, scope.ProjectID, pool.ID).Scan(&currentComputers); err != nil {
		return cloudplane.HostPool{}, databaseFailure("count Host Pool Computers", err)
	}
	if currentComputers > int(pool.MaxComputers) {
		return cloudplane.HostPool{}, cloudplane.ErrConflict
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	if _, err := tx.Exec(ctx, `INSERT INTO zapvm.host_pools (tenant_id,project_id,pool_id,display_name,region,enabled,max_computers,labels,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (tenant_id,project_id,pool_id) DO UPDATE SET display_name=EXCLUDED.display_name,region=EXCLUDED.region,enabled=EXCLUDED.enabled,max_computers=EXCLUDED.max_computers,labels=EXCLUDED.labels,updated_at=EXCLUDED.updated_at`, scope.TenantID, scope.ProjectID, pool.ID, pool.DisplayName, pool.Region, pool.Enabled, pool.MaxComputers, labels, now); err != nil {
		return cloudplane.HostPool{}, databaseFailure("upsert Host Pool", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM zapvm.host_pool_nodes WHERE tenant_id=$1 AND project_id=$2 AND pool_id=$3`, scope.TenantID, scope.ProjectID, pool.ID); err != nil {
		return cloudplane.HostPool{}, databaseFailure("replace Host Pool Nodes", err)
	}
	sort.Strings(pool.NodeIDs)
	for index, nodeID := range pool.NodeIDs {
		if !queueIDPattern.MatchString(nodeID) || (index > 0 && pool.NodeIDs[index-1] == nodeID) {
			return cloudplane.HostPool{}, errors.New("Host Pool Node list is invalid")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO zapvm.host_pool_nodes (tenant_id,project_id,pool_id,node_id) VALUES ($1,$2,$3,$4)`, scope.TenantID, scope.ProjectID, pool.ID, nodeID); err != nil {
			return cloudplane.HostPool{}, databaseFailure("assign Host Pool Node", err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM zapvm.computer_nodes n USING zapvm.computer_profiles p WHERE n.tenant_id=p.tenant_id AND n.project_id=p.project_id AND n.computer_id=p.computer_id AND p.tenant_id=$1 AND p.project_id=$2 AND p.pool_id=$3`, scope.TenantID, scope.ProjectID, pool.ID); err != nil {
		return cloudplane.HostPool{}, databaseFailure("clear Host Pool Computer assignments", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) SELECT p.tenant_id,p.project_id,p.computer_id,n.node_id FROM zapvm.computer_profiles p JOIN zapvm.host_pool_nodes n ON n.tenant_id=p.tenant_id AND n.project_id=p.project_id AND n.pool_id=p.pool_id WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.pool_id=$3`, scope.TenantID, scope.ProjectID, pool.ID); err != nil {
		return cloudplane.HostPool{}, databaseFailure("refresh Host Pool Computer assignments", err)
	}
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "host_pool_upsert", scope: scope, principal: principal, outcome: pool.ID}); err != nil {
		return cloudplane.HostPool{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.HostPool{}, databaseFailure("commit Host Pool", err)
	}
	items, err := queue.ListHostPools(ctx, scope)
	if err != nil {
		return cloudplane.HostPool{}, err
	}
	for _, item := range items {
		if item.ID == pool.ID {
			return item, nil
		}
	}
	return cloudplane.HostPool{}, cloudplane.ErrNotFound
}

func (queue *Queue) DeleteHostPool(ctx context.Context, principal string, scope cloudplane.Scope, id string) error {
	return queue.deletePlatformRow(ctx, principal, scope, "host_pools", "pool_id", id, "host_pool_delete")
}

func (queue *Queue) ListModelProfiles(ctx context.Context, scope cloudplane.Scope) ([]cloudplane.ModelProfile, error) {
	tx, rows, err := queue.platformRows(ctx, scope, `SELECT model_id,display_name,provider_url,provider_model,credential_id,enabled,created_at,updated_at FROM zapvm.model_profiles WHERE tenant_id=$1 AND project_id=$2 ORDER BY model_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []cloudplane.ModelProfile{}
	for rows.Next() {
		var item cloudplane.ModelProfile
		var c, u time.Time
		if rows.Scan(&item.ID, &item.DisplayName, &item.ProviderURL, &item.ProviderModel, &item.CredentialID, &item.Enabled, &c, &u) != nil {
			return nil, errors.New("decode Model profile")
		}
		item.CreatedAt, item.UpdatedAt = platformTime(c), platformTime(u)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, databaseFailure("commit Model profile list", err)
	}
	return result, nil
}
func (queue *Queue) PutModelProfile(ctx context.Context, principal string, scope cloudplane.Scope, p cloudplane.ModelProfile) (cloudplane.ModelProfile, error) {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || !queueIDPattern.MatchString(p.ID) || strings.TrimSpace(p.DisplayName) == "" || !credential.ValidID(p.CredentialID) {
		return cloudplane.ModelProfile{}, cloudplane.ErrUnauthorized
	}
	u, err := url.Parse(p.ProviderURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return cloudplane.ModelProfile{}, errors.New("Model provider URL is invalid")
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.ModelProfile{}, err
	}
	defer rollbackBounded(tx)
	_, err = tx.Exec(ctx, `INSERT INTO zapvm.model_profiles (tenant_id,project_id,model_id,display_name,provider_url,provider_model,credential_id,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (tenant_id,project_id,model_id) DO UPDATE SET display_name=EXCLUDED.display_name,provider_url=EXCLUDED.provider_url,provider_model=EXCLUDED.provider_model,credential_id=EXCLUDED.credential_id,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at`, scope.TenantID, scope.ProjectID, p.ID, p.DisplayName, p.ProviderURL, p.ProviderModel, p.CredentialID, p.Enabled, now)
	if err != nil {
		return cloudplane.ModelProfile{}, databaseFailure("upsert Model profile", err)
	}
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "model_upsert", scope: scope, principal: principal, outcome: p.ID}); err != nil {
		return cloudplane.ModelProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.ModelProfile{}, databaseFailure("commit Model profile", err)
	}
	p.CreatedAt, p.UpdatedAt = platformTime(now), platformTime(now)
	return p, nil
}
func (queue *Queue) DeleteModelProfile(ctx context.Context, principal string, scope cloudplane.Scope, id string) error {
	return queue.deletePlatformRow(ctx, principal, scope, "model_profiles", "model_id", id, "model_delete")
}

func (queue *Queue) ListAgentProfiles(ctx context.Context, scope cloudplane.Scope) ([]cloudplane.AgentProfile, error) {
	tx, rows, err := queue.platformRows(ctx, scope, `SELECT agent_id,display_name,runtime_ref,model_id,enabled,configuration,created_at,updated_at FROM zapvm.agent_profiles WHERE tenant_id=$1 AND project_id=$2 ORDER BY agent_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []cloudplane.AgentProfile{}
	for rows.Next() {
		var item cloudplane.AgentProfile
		var c, u time.Time
		if rows.Scan(&item.ID, &item.DisplayName, &item.RuntimeRef, &item.ModelID, &item.Enabled, &item.Configuration, &c, &u) != nil {
			return nil, errors.New("decode Agent profile")
		}
		item.CreatedAt, item.UpdatedAt = platformTime(c), platformTime(u)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, databaseFailure("commit Agent profile list", err)
	}
	return result, nil
}
func (queue *Queue) PutAgentProfile(ctx context.Context, principal string, scope cloudplane.Scope, p cloudplane.AgentProfile) (cloudplane.AgentProfile, error) {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || !queueIDPattern.MatchString(p.ID) || strings.TrimSpace(p.DisplayName) == "" || !strings.Contains(p.RuntimeRef, "@") || !queueIDPattern.MatchString(p.ModelID) {
		return cloudplane.AgentProfile{}, cloudplane.ErrUnauthorized
	}
	if len(p.Configuration) == 0 {
		p.Configuration = json.RawMessage(`{}`)
	}
	if !json.Valid(p.Configuration) || len(p.Configuration) > 64<<10 {
		return cloudplane.AgentProfile{}, errors.New("Agent configuration is invalid")
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.AgentProfile{}, err
	}
	defer rollbackBounded(tx)
	_, err = tx.Exec(ctx, `INSERT INTO zapvm.agent_profiles (tenant_id,project_id,agent_id,display_name,runtime_ref,model_id,enabled,configuration,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (tenant_id,project_id,agent_id) DO UPDATE SET display_name=EXCLUDED.display_name,runtime_ref=EXCLUDED.runtime_ref,model_id=EXCLUDED.model_id,enabled=EXCLUDED.enabled,configuration=EXCLUDED.configuration,updated_at=EXCLUDED.updated_at`, scope.TenantID, scope.ProjectID, p.ID, p.DisplayName, p.RuntimeRef, p.ModelID, p.Enabled, p.Configuration, now)
	if err != nil {
		return cloudplane.AgentProfile{}, databaseFailure("upsert Agent profile", err)
	}
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "agent_upsert", scope: scope, principal: principal, outcome: p.ID}); err != nil {
		return cloudplane.AgentProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.AgentProfile{}, databaseFailure("commit Agent profile", err)
	}
	p.CreatedAt, p.UpdatedAt = platformTime(now), platformTime(now)
	return p, nil
}
func (queue *Queue) DeleteAgentProfile(ctx context.Context, principal string, scope cloudplane.Scope, id string) error {
	return queue.deletePlatformRow(ctx, principal, scope, "agent_profiles", "agent_id", id, "agent_delete")
}

func (queue *Queue) ListComputerProfiles(ctx context.Context, scope cloudplane.Scope) ([]cloudplane.ComputerProfile, error) {
	tx, rows, err := queue.platformRows(ctx, scope, `SELECT computer_id,display_name,pool_id,agent_id,vcpu,memory_bytes,browser_enabled,created_by,created_at,updated_at FROM zapvm.computer_profiles WHERE tenant_id=$1 AND project_id=$2 ORDER BY computer_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []cloudplane.ComputerProfile{}
	for rows.Next() {
		var item cloudplane.ComputerProfile
		var c, u time.Time
		if rows.Scan(&item.ID, &item.DisplayName, &item.PoolID, &item.AgentID, &item.VCPU, &item.MemoryBytes, &item.BrowserEnabled, &item.CreatedBy, &c, &u) != nil {
			return nil, errors.New("decode Computer profile")
		}
		item.CreatedAt, item.UpdatedAt = platformTime(c), platformTime(u)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, databaseFailure("commit Computer profile list", err)
	}
	return result, nil
}
func (queue *Queue) CreateComputerProfile(ctx context.Context, principal string, scope cloudplane.Scope, p cloudplane.ComputerProfile) (cloudplane.ComputerProfile, error) {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil {
		return cloudplane.ComputerProfile{}, cloudplane.ErrUnauthorized
	}
	if !computer.ValidID(p.ID) || strings.TrimSpace(p.DisplayName) == "" || len(p.DisplayName) > 128 || !queueIDPattern.MatchString(p.PoolID) || !queueIDPattern.MatchString(p.AgentID) || !queueNamePattern.MatchString(p.CreatedBy) || p.VCPU < 1 || p.VCPU > 128 || p.MemoryBytes < 512<<20 || p.MemoryBytes > 1<<40 {
		return cloudplane.ComputerProfile{}, errors.New("Computer profile is invalid")
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.ComputerProfile{}, err
	}
	defer rollbackBounded(tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "computer-create|"+scope.TenantID+"|"+scope.ProjectID); err != nil {
		return cloudplane.ComputerProfile{}, databaseFailure("lock Computer quota", err)
	}
	var count, max int
	if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM zapvm.computers WHERE tenant_id=$1 AND project_id=$2),COALESCE((SELECT max_computers FROM zapvm.workspace_quotas WHERE tenant_id=$1 AND project_id=$2),10)`, scope.TenantID, scope.ProjectID).Scan(&count, &max); err != nil {
		return cloudplane.ComputerProfile{}, databaseFailure("check Computer quota", err)
	}
	if count >= max {
		return cloudplane.ComputerProfile{}, cloudplane.ErrQuotaReached
	}
	var runtime string
	var poolCount, poolMax int
	if err := tx.QueryRow(ctx, `SELECT a.runtime_ref,(SELECT count(*) FROM zapvm.computer_profiles cp WHERE cp.tenant_id=p.tenant_id AND cp.project_id=p.project_id AND cp.pool_id=p.pool_id),p.max_computers FROM zapvm.agent_profiles a JOIN zapvm.host_pools p USING (tenant_id,project_id) WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.agent_id=$3 AND a.enabled AND p.pool_id=$4 AND p.enabled`, scope.TenantID, scope.ProjectID, p.AgentID, p.PoolID).Scan(&runtime, &poolCount, &poolMax); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ComputerProfile{}, cloudplane.ErrNotFound
	} else if err != nil {
		return cloudplane.ComputerProfile{}, databaseFailure("resolve Computer runtime", err)
	}
	if poolCount >= poolMax {
		return cloudplane.ComputerProfile{}, cloudplane.ErrQuotaReached
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	if _, err := tx.Exec(ctx, `INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,agent,created_at,provisioning_source) VALUES ($1,$2,$3,$4,$5,'self_service')`, scope.TenantID, scope.ProjectID, p.ID, runtime, now); err != nil {
		return cloudplane.ComputerProfile{}, databaseFailure("create self-service Computer", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO zapvm.computer_profiles (tenant_id,project_id,computer_id,display_name,pool_id,agent_id,vcpu,memory_bytes,browser_enabled,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, scope.TenantID, scope.ProjectID, p.ID, p.DisplayName, p.PoolID, p.AgentID, p.VCPU, p.MemoryBytes, p.BrowserEnabled, p.CreatedBy, now); err != nil {
		return cloudplane.ComputerProfile{}, databaseFailure("create Computer profile", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) SELECT tenant_id,project_id,$3,node_id FROM zapvm.host_pool_nodes WHERE tenant_id=$1 AND project_id=$2 AND pool_id=$4`, scope.TenantID, scope.ProjectID, p.ID, p.PoolID); err != nil {
		return cloudplane.ComputerProfile{}, databaseFailure("assign Computer Host Pool", err)
	}
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "computer_create", scope: scope, principal: principal, outcome: p.ID}); err != nil {
		return cloudplane.ComputerProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.ComputerProfile{}, databaseFailure("commit Computer creation", err)
	}
	p.CreatedAt, p.UpdatedAt = platformTime(now), platformTime(now)
	return p, nil
}
func (queue *Queue) DeleteComputerProfile(ctx context.Context, principal string, scope cloudplane.Scope, id string) error {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || !computer.ValidID(id) {
		return cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(tx)
	var active int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM zapvm.tasks WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3 AND state IN ('pending','leased','running','canceling')`, scope.TenantID, scope.ProjectID, id).Scan(&active); err != nil {
		return databaseFailure("check Computer activity", err)
	}
	if active > 0 {
		return cloudplane.ErrConflict
	}
	command, err := tx.Exec(ctx, `DELETE FROM zapvm.computers WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3 AND provisioning_source='self_service'`, scope.TenantID, scope.ProjectID, id)
	if err != nil {
		return databaseFailure("delete self-service Computer", err)
	}
	if command.RowsAffected() != 1 {
		return cloudplane.ErrNotFound
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "computer_delete", scope: scope, principal: principal, outcome: id}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (queue *Queue) GetWorkspaceQuota(ctx context.Context, scope cloudplane.Scope) (cloudplane.WorkspaceQuota, error) {
	if queue == nil || ctx == nil || scope.Validate() != nil {
		return cloudplane.WorkspaceQuota{}, cloudplane.ErrUnauthorized
	}
	var q cloudplane.WorkspaceQuota
	var updated time.Time
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceQuota{}, err
	}
	defer rollbackBounded(tx)
	err = tx.QueryRow(ctx, `SELECT max_computers,max_concurrent_tasks,monthly_task_seconds,artifact_bytes,updated_at FROM zapvm.workspace_quotas WHERE tenant_id=$1 AND project_id=$2`, scope.TenantID, scope.ProjectID).Scan(&q.MaxComputers, &q.MaxConcurrentTasks, &q.MonthlyTaskSeconds, &q.ArtifactBytes, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceQuota{MaxComputers: 10, MaxConcurrentTasks: 5, MonthlyTaskSeconds: 360000, ArtifactBytes: 100 << 30}, nil
	}
	if err != nil {
		return cloudplane.WorkspaceQuota{}, databaseFailure("read Workspace quota", err)
	}
	q.UpdatedAt = platformTime(updated)
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.WorkspaceQuota{}, databaseFailure("commit Workspace quota read", err)
	}
	return q, nil
}
func (queue *Queue) PutWorkspaceQuota(ctx context.Context, principal string, scope cloudplane.Scope, q cloudplane.WorkspaceQuota) (cloudplane.WorkspaceQuota, error) {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || q.MaxComputers < 1 || q.MaxConcurrentTasks < 1 || q.MonthlyTaskSeconds < 60 || q.ArtifactBytes < 5<<30 {
		return cloudplane.WorkspaceQuota{}, cloudplane.ErrUnauthorized
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceQuota{}, err
	}
	defer rollbackBounded(tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "computer-create|"+scope.TenantID+"|"+scope.ProjectID); err != nil {
		return cloudplane.WorkspaceQuota{}, databaseFailure("lock Workspace quota update", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO zapvm.workspace_quotas (tenant_id,project_id,max_computers,max_concurrent_tasks,monthly_task_seconds,artifact_bytes,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,project_id) DO UPDATE SET max_computers=EXCLUDED.max_computers,max_concurrent_tasks=EXCLUDED.max_concurrent_tasks,monthly_task_seconds=EXCLUDED.monthly_task_seconds,artifact_bytes=EXCLUDED.artifact_bytes,updated_at=EXCLUDED.updated_at`, scope.TenantID, scope.ProjectID, q.MaxComputers, q.MaxConcurrentTasks, q.MonthlyTaskSeconds, q.ArtifactBytes, now)
	if err != nil {
		return cloudplane.WorkspaceQuota{}, databaseFailure("upsert Workspace quota", err)
	}
	if _, err := appendAudit(ctx, tx, now, auditInput{action: "quota_update", scope: scope, principal: principal, outcome: "accepted"}); err != nil {
		return cloudplane.WorkspaceQuota{}, err
	}
	q.UpdatedAt = platformTime(now)
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.WorkspaceQuota{}, databaseFailure("commit Workspace quota", err)
	}
	return q, nil
}
func (queue *Queue) GetWorkspaceUsage(ctx context.Context, scope cloudplane.Scope) (cloudplane.WorkspaceUsage, error) {
	if queue == nil || ctx == nil || scope.Validate() != nil {
		return cloudplane.WorkspaceUsage{}, cloudplane.ErrUnauthorized
	}
	var u cloudplane.WorkspaceUsage
	var period time.Time
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceUsage{}, err
	}
	defer rollbackBounded(tx)
	err = tx.QueryRow(ctx, `WITH p AS (SELECT date_trunc('month',clock_timestamp())::date AS start) SELECT p.start,(SELECT count(*) FROM zapvm.tasks t WHERE t.tenant_id=$1 AND t.project_id=$2 AND t.created_at>=p.start),(SELECT COALESCE(sum(EXTRACT(EPOCH FROM (t.updated_at-t.created_at)))::bigint,0) FROM zapvm.tasks t WHERE t.tenant_id=$1 AND t.project_id=$2 AND t.created_at>=p.start AND t.state IN ('succeeded','failed','canceled')),(SELECT COALESCE(sum(a.size_bytes),0) FROM zapvm.artifacts a WHERE a.tenant_id=$1 AND a.project_id=$2),(SELECT count(*) FROM zapvm.tasks t WHERE t.tenant_id=$1 AND t.project_id=$2 AND t.state IN ('pending','leased','running','canceling')),(SELECT count(*) FROM zapvm.computers x WHERE x.tenant_id=$1 AND x.project_id=$2) FROM p`, scope.TenantID, scope.ProjectID).Scan(&period, &u.TaskCount, &u.TaskSeconds, &u.ArtifactBytes, &u.RunningTasks, &u.ComputerCount)
	if err != nil {
		return cloudplane.WorkspaceUsage{}, databaseFailure("read Workspace usage", err)
	}
	u.PeriodStart = period.Format("2006-01-02")
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.WorkspaceUsage{}, databaseFailure("commit Workspace usage read", err)
	}
	return u, nil
}

func (queue *Queue) ResolveComputerRuntime(ctx context.Context, scope cloudplane.Scope, computerID string) (cloudplane.ComputerRuntimeSelection, error) {
	if queue == nil || ctx == nil || scope.Validate() != nil || !computer.ValidID(computerID) {
		return cloudplane.ComputerRuntimeSelection{}, cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.ComputerRuntimeSelection{}, err
	}
	defer rollbackBounded(tx)
	var selection cloudplane.ComputerRuntimeSelection
	var maxTurns, timeoutSeconds int64
	err = tx.QueryRow(ctx, `
SELECT cp.computer_id,ap.agent_id,ap.display_name,ap.runtime_ref,mp.provider_url,mp.provider_model,mp.credential_id,
       COALESCE(ap.configuration->>'search_credential_id',''),
       COALESCE(NULLIF(ap.configuration->>'max_turns','')::bigint,0),
       COALESCE(NULLIF(ap.configuration->>'timeout_seconds','')::bigint,0)
FROM zapvm.computer_profiles cp
JOIN zapvm.agent_profiles ap ON ap.tenant_id=cp.tenant_id AND ap.project_id=cp.project_id AND ap.agent_id=cp.agent_id
JOIN zapvm.model_profiles mp ON mp.tenant_id=ap.tenant_id AND mp.project_id=ap.project_id AND mp.model_id=ap.model_id
WHERE cp.tenant_id=$1 AND cp.project_id=$2 AND cp.computer_id=$3 AND ap.enabled AND mp.enabled`, scope.TenantID, scope.ProjectID, computerID).Scan(
		&selection.ComputerID, &selection.AgentID, &selection.DisplayName, &selection.RuntimeRef, &selection.ProviderBaseURL,
		&selection.Model, &selection.ModelCredentialID, &selection.SearchCredentialID, &maxTurns, &timeoutSeconds)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ComputerRuntimeSelection{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.ComputerRuntimeSelection{}, databaseFailure("resolve Computer runtime", err)
	}
	if maxTurns < 0 || maxTurns > 65535 || timeoutSeconds < 0 || timeoutSeconds > 4294967295 || (selection.SearchCredentialID != "" && !credential.ValidID(selection.SearchCredentialID)) {
		return cloudplane.ComputerRuntimeSelection{}, errors.New("Computer runtime configuration is invalid")
	}
	selection.MaxTurns, selection.TimeoutSeconds = uint16(maxTurns), uint32(timeoutSeconds)
	if err := tx.Commit(ctx); err != nil {
		return cloudplane.ComputerRuntimeSelection{}, databaseFailure("commit Computer runtime resolution", err)
	}
	return selection, nil
}

func (queue *Queue) validatePlatformCall(ctx context.Context, principal string, scope cloudplane.Scope) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !cloudplane.ValidPrincipal(principal) || scope.Validate() != nil {
		return cloudplane.ErrUnauthorized
	}
	return nil
}
func (queue *Queue) platformRows(ctx context.Context, scope cloudplane.Scope, query string) (pgx.Tx, pgx.Rows, error) {
	if queue == nil || ctx == nil || scope.Validate() != nil {
		return nil, nil, cloudplane.ErrUnauthorized
	}
	tx, err := queue.begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query(ctx, query, scope.TenantID, scope.ProjectID)
	if err != nil {
		rollbackBounded(tx)
		return nil, nil, databaseFailure("query platform administration", err)
	}
	return tx, rows, nil
}
func (queue *Queue) deletePlatformRow(ctx context.Context, principal string, scope cloudplane.Scope, table, column, id, action string) error {
	if err := queue.validatePlatformCall(ctx, principal, scope); err != nil || !queueIDPattern.MatchString(id) {
		return cloudplane.ErrUnauthorized
	}
	query := `DELETE FROM zapvm.` + table + ` WHERE tenant_id=$1 AND project_id=$2 AND ` + column + `=$3`
	tx, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(tx)
	command, err := tx.Exec(ctx, query, scope.TenantID, scope.ProjectID, id)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23503" {
			return cloudplane.ErrConflict
		}
		return databaseFailure("delete platform object", err)
	}
	if command.RowsAffected() != 1 {
		return cloudplane.ErrNotFound
	}
	now := queue.now().UTC().Truncate(time.Microsecond)
	if _, err := appendAudit(ctx, tx, now, auditInput{action: action, scope: scope, principal: principal, outcome: id}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func platformTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }
