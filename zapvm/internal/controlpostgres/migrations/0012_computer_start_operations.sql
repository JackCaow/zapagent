CREATE TABLE zapvm.computer_operations (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,128}$'),
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    placement_epoch bigint NOT NULL CHECK (placement_epoch > 0),
    kind text NOT NULL CHECK (kind IN ('start')),
    state text NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'failed')),
    node_id text REFERENCES zapvm.nodes(id) ON DELETE RESTRICT,
    node_generation text CHECK (node_generation IS NULL OR node_generation ~ '^[A-Za-z0-9._-]{16,128}$'),
    attempt smallint NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 10),
    lease_token_hash bytea CHECK (lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32),
    lease_expires_at timestamptz,
    deadline_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    completed_at timestamptz,
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
    FOREIGN KEY (tenant_id, project_id, computer_id, placement_epoch)
        REFERENCES zapvm.computer_placements(tenant_id, project_id, computer_id, epoch)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CHECK ((state = 'leased') = (node_id IS NOT NULL AND node_generation IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK ((state IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
    CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
    CHECK (deadline_at > created_at)
);

CREATE UNIQUE INDEX computer_operations_active_unique
    ON zapvm.computer_operations (tenant_id, project_id, computer_id, kind)
    WHERE state IN ('pending', 'leased');

CREATE INDEX computer_operations_node_pending_idx
    ON zapvm.computer_operations (node_id, state, deadline_at)
    WHERE state = 'leased';

CREATE INDEX computer_operations_placement_idx
    ON zapvm.computer_operations (tenant_id, project_id, computer_id, placement_epoch, kind, state);

ALTER TABLE zapvm.computer_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computer_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY computer_operations_tenant_isolation ON zapvm.computer_operations
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
