ALTER TABLE zapvm.tasks
    ADD COLUMN queue_reason text
        CHECK (queue_reason IS NULL OR queue_reason IN ('dispatch_wait', 'capacity_wait', 'node_offline', 'computer_starting')),
    ADD COLUMN queue_deadline timestamptz;

UPDATE zapvm.tasks
SET queue_reason = 'dispatch_wait',
    queue_deadline = updated_at + interval '2 minutes'
WHERE state = 'pending';

CREATE TABLE zapvm.computer_runtime (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    desired_state text NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'stopped')),
    observed_state text NOT NULL DEFAULT 'unavailable'
        CHECK (observed_state IN ('unavailable', 'ready', 'busy', 'degraded')),
    assigned_node_id text REFERENCES zapvm.nodes(id) ON DELETE SET NULL,
    placement_epoch bigint NOT NULL DEFAULT 0 CHECK (placement_epoch >= 0),
    state_generation bigint NOT NULL DEFAULT 0 CHECK (state_generation >= 0),
    last_activity_at timestamptz,
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, computer_id),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE CASCADE,
    CHECK (observed_state IN ('unavailable', 'degraded') OR failure_code IS NULL)
);

INSERT INTO zapvm.computer_runtime
    (tenant_id, project_id, computer_id, desired_state, observed_state, last_activity_at)
SELECT tenant_id, project_id, computer_id, 'running', 'unavailable', created_at
FROM zapvm.computers;

CREATE INDEX computer_runtime_node_idx
    ON zapvm.computer_runtime (assigned_node_id)
    WHERE assigned_node_id IS NOT NULL;

CREATE INDEX computer_runtime_observed_idx
    ON zapvm.computer_runtime (tenant_id, project_id, observed_state, updated_at);

ALTER TABLE zapvm.computer_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computer_runtime FORCE ROW LEVEL SECURITY;
CREATE POLICY computer_runtime_tenant_isolation ON zapvm.computer_runtime
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
