ALTER TABLE zapvm.tasks
    ADD COLUMN payload_raw bytea CHECK (payload_raw IS NULL OR octet_length(payload_raw) BETWEEN 1 AND 1048576);

CREATE TABLE zapvm.task_transition_receipts (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    task_id text NOT NULL,
    attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 10),
    action text NOT NULL CHECK (action IN ('ack', 'complete', 'canceled')),
    lease_token_hash bytea NOT NULL CHECK (octet_length(lease_token_hash) = 32),
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
    response_state text NOT NULL CHECK (response_state IN ('running', 'canceling', 'succeeded', 'failed', 'canceled')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, task_id, attempt, action),
    FOREIGN KEY (tenant_id, project_id, task_id)
        REFERENCES zapvm.tasks(tenant_id, project_id, id) ON DELETE CASCADE
);

CREATE TABLE zapvm.task_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    task_id text NOT NULL,
    attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 10),
    kind text NOT NULL CHECK (kind IN ('leased', 'running', 'event', 'canceling', 'requeued', 'terminal')),
    event_cursor bigint CHECK (event_cursor IS NULL OR event_cursor > 0),
    dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claimed_by text CHECK (claimed_by IS NULL OR claimed_by ~ '^[A-Za-z0-9._-]{1,128}$'),
    claim_expires_at timestamptz,
    delivered_at timestamptz,
    FOREIGN KEY (tenant_id, project_id, task_id)
        REFERENCES zapvm.tasks(tenant_id, project_id, id) ON DELETE CASCADE,
    CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL)),
    CHECK (delivered_at IS NULL OR delivered_at >= created_at),
    CHECK ((kind = 'event') = (event_cursor IS NOT NULL))
);

CREATE INDEX task_outbox_delivery_idx
    ON zapvm.task_outbox (delivered_at, claim_expires_at, id);

ALTER TABLE zapvm.task_transition_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.task_transition_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY task_transition_receipts_tenant_isolation ON zapvm.task_transition_receipts
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));

ALTER TABLE zapvm.task_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.task_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY task_outbox_tenant_isolation ON zapvm.task_outbox
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
