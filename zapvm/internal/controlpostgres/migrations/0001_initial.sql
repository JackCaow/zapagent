CREATE TABLE zapvm.control_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    audit_sequence bigint NOT NULL DEFAULT 0 CHECK (audit_sequence >= 0),
    dispatch_sequence bigint NOT NULL DEFAULT 0 CHECK (dispatch_sequence >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO zapvm.control_state (singleton) VALUES (true);

CREATE TABLE zapvm.nodes (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,128}$'),
    generation text NOT NULL CHECK (generation ~ '^[A-Za-z0-9._-]{16,128}$'),
    state text NOT NULL CHECK (state IN ('online', 'offline', 'draining')),
    capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1024),
    in_flight integer NOT NULL DEFAULT 0 CHECK (in_flight BETWEEN 0 AND capacity),
    last_heartbeat timestamptz NOT NULL,
    node_version text,
    daemon_version text,
    image_digest bytea CHECK (image_digest IS NULL OR octet_length(image_digest) = 32),
    daemon_state text NOT NULL CHECK (daemon_state IN ('unknown', 'healthy', 'paused', 'degraded', 'unreachable')),
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
    start_attempts bigint NOT NULL DEFAULT 0 CHECK (start_attempts >= 0),
    start_failures bigint NOT NULL DEFAULT 0 CHECK (start_failures BETWEEN 0 AND start_attempts),
    start_duration_ms_total bigint NOT NULL DEFAULT 0 CHECK (start_duration_ms_total >= 0),
    start_duration_ms_max bigint NOT NULL DEFAULT 0 CHECK (start_duration_ms_max BETWEEN 0 AND start_duration_ms_total),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((daemon_state IN ('degraded', 'unreachable')) = (failure_code IS NOT NULL)),
    CHECK (start_attempts <> 0 OR (start_failures = 0 AND start_duration_ms_total = 0 AND start_duration_ms_max = 0))
);

CREATE TABLE zapvm.node_scopes (
    node_id text NOT NULL REFERENCES zapvm.nodes(id) ON DELETE CASCADE,
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    PRIMARY KEY (node_id, tenant_id, project_id)
);

CREATE TABLE zapvm.computers (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    node_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, computer_id),
    FOREIGN KEY (node_id, tenant_id, project_id)
        REFERENCES zapvm.node_scopes(node_id, tenant_id, project_id) ON DELETE CASCADE
);

CREATE TABLE zapvm.agent_sessions (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    computer_id text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, project_id, session_id),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at)
);

CREATE TABLE zapvm.tasks (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,128}$'),
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL,
    session_id text,
    payload jsonb NOT NULL,
    payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
    credential_ids text[] NOT NULL DEFAULT '{}',
    retry_of text,
    state text NOT NULL CHECK (state IN ('pending', 'leased', 'running', 'canceling', 'succeeded', 'failed', 'canceled')),
    node_id text REFERENCES zapvm.nodes(id) ON DELETE RESTRICT,
    node_generation text,
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 10),
    lease_token_hash bytea CHECK (lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32),
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL,
    created_sequence bigint NOT NULL UNIQUE CHECK (created_sequence > 0),
    updated_at timestamptz NOT NULL,
    result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256) = 32),
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
    dispatch_sequence bigint CHECK (dispatch_sequence IS NULL OR dispatch_sequence > 0),
    UNIQUE (tenant_id, project_id, id),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, session_id)
        REFERENCES zapvm.agent_sessions(tenant_id, project_id, session_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, retry_of)
        REFERENCES zapvm.tasks(tenant_id, project_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (node_id, tenant_id, project_id)
        REFERENCES zapvm.node_scopes(node_id, tenant_id, project_id) ON DELETE RESTRICT,
    CHECK (session_id IS NULL OR session_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    CHECK (cardinality(credential_ids) <= 16),
    CHECK (updated_at >= created_at),
    CHECK (
        (state = 'pending' AND node_id IS NULL AND node_generation IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
        OR
        (state IN ('leased', 'running', 'canceling') AND node_id IS NOT NULL AND node_generation IS NOT NULL AND
            node_generation ~ '^[A-Za-z0-9._-]{16,128}$' AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (state IN ('succeeded', 'failed', 'canceled') AND node_id IS NULL AND node_generation IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
    CHECK (result_sha256 IS NULL OR state IN ('succeeded', 'failed'))
);

CREATE UNIQUE INDEX tasks_active_lease_token_unique
    ON zapvm.tasks (lease_token_hash) WHERE lease_token_hash IS NOT NULL;
CREATE INDEX tasks_scope_creation_idx
    ON zapvm.tasks (tenant_id, project_id, created_sequence);
CREATE INDEX tasks_dispatch_idx
    ON zapvm.tasks (tenant_id, project_id, state, dispatch_sequence, created_sequence)
    WHERE state = 'pending';
CREATE INDEX tasks_session_idx
    ON zapvm.tasks (tenant_id, project_id, session_id, created_sequence)
    WHERE session_id IS NOT NULL;

CREATE TABLE zapvm.task_events (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    task_id text NOT NULL,
    cursor bigint NOT NULL CHECK (cursor > 0),
    attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 10),
    source_cursor bigint NOT NULL CHECK (source_cursor > 0),
    occurred_at timestamptz NOT NULL,
    type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9._-]{0,63}$'),
    command_id text,
    stream text,
    data bytea,
    pid integer CHECK (pid IS NULL OR pid >= 0),
    ok boolean,
    error text,
    PRIMARY KEY (tenant_id, project_id, task_id, cursor),
    UNIQUE (tenant_id, project_id, task_id, attempt, source_cursor),
    FOREIGN KEY (tenant_id, project_id, task_id)
        REFERENCES zapvm.tasks(tenant_id, project_id, id) ON DELETE CASCADE,
    CHECK (octet_length(data) <= 1048576),
    CHECK (error IS NULL OR octet_length(error) <= 1048576)
);

CREATE TABLE zapvm.workspace_operations (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,128}$'),
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('list', 'read', 'diff', 'git_push')),
    path text,
    task_id text,
    provider_id text,
    branch text,
    state text NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'failed')),
    node_id text REFERENCES zapvm.nodes(id) ON DELETE RESTRICT,
    node_generation text,
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 10),
    lease_token_hash bytea CHECK (lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32),
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    result jsonb,
    result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256) = 32),
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
    created_sequence bigint NOT NULL UNIQUE CHECK (created_sequence > 0),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, task_id)
        REFERENCES zapvm.tasks(tenant_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (node_id, tenant_id, project_id)
        REFERENCES zapvm.node_scopes(node_id, tenant_id, project_id) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at AND expires_at > created_at),
    CHECK (
        (kind = 'git_push' AND path IS NULL AND task_id IS NOT NULL AND provider_id IS NOT NULL AND branch = 'zapvm/' || id)
        OR
        (kind <> 'git_push' AND task_id IS NULL AND provider_id IS NULL AND branch IS NULL)
    ),
    CHECK (
        (state = 'pending' AND node_id IS NULL AND node_generation IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
        OR
        (state = 'leased' AND node_id IS NOT NULL AND node_generation IS NOT NULL AND
            node_generation ~ '^[A-Za-z0-9._-]{16,128}$' AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (state IN ('succeeded', 'failed') AND node_id IS NULL AND node_generation IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
    CHECK ((state = 'succeeded') = (result IS NOT NULL)),
    CHECK ((state = 'succeeded') = (result_sha256 IS NOT NULL)),
    CHECK (
        (kind = 'list' AND path IS NOT NULL AND octet_length(path) <= 4096)
        OR (kind = 'read' AND path IS NOT NULL AND path <> '' AND octet_length(path) <= 4096)
        OR (kind = 'diff' AND path IS NOT NULL AND octet_length(path) <= 4096)
        OR (kind = 'git_push' AND path IS NULL AND provider_id ~ '^[A-Za-z0-9._-]{1,128}$')
    )
);

CREATE UNIQUE INDEX workspace_active_lease_token_unique
    ON zapvm.workspace_operations (lease_token_hash) WHERE lease_token_hash IS NOT NULL;
CREATE INDEX workspace_scope_created_idx
    ON zapvm.workspace_operations (tenant_id, project_id, created_sequence);
CREATE INDEX workspace_claim_idx
    ON zapvm.workspace_operations (tenant_id, project_id, state, created_sequence)
    WHERE state = 'pending';

CREATE TABLE zapvm.artifacts (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,128}$'),
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL,
    session_id text NOT NULL,
    task_id text NOT NULL,
    path text NOT NULL CHECK (path <> '' AND octet_length(path) <= 4096),
    name text NOT NULL CHECK (name <> '' AND octet_length(name) <= 255),
    content_type text NOT NULL CHECK (content_type <> '' AND octet_length(content_type) <= 255),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 5368709120),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    state text NOT NULL CHECK (state IN ('pending', 'available', 'failed', 'expired')),
    retention_seconds bigint NOT NULL CHECK (retention_seconds BETWEEN 3600 AND 2592000),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
    object_key text,
    available_at timestamptz,
    created_sequence bigint NOT NULL UNIQUE CHECK (created_sequence > 0),
    registered_node_id text NOT NULL,
    registered_node_generation text NOT NULL CHECK (registered_node_generation ~ '^[A-Za-z0-9._-]{16,128}$'),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, session_id)
        REFERENCES zapvm.agent_sessions(tenant_id, project_id, session_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, task_id)
        REFERENCES zapvm.tasks(tenant_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (registered_node_id, tenant_id, project_id)
        REFERENCES zapvm.node_scopes(node_id, tenant_id, project_id) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at AND expires_at = created_at + retention_seconds * interval '1 second'),
    CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
    CHECK (
        (state = 'available' AND object_key IS NOT NULL AND available_at IS NOT NULL)
        OR (state = 'expired' AND ((object_key IS NULL AND available_at IS NULL) OR (object_key IS NOT NULL AND available_at IS NOT NULL)))
        OR (state IN ('pending', 'failed') AND object_key IS NULL AND available_at IS NULL)
    ),
    CHECK (object_key IS NULL OR (octet_length(object_key) <= 512 AND object_key ~ '^[a-z0-9/_-]+$' AND object_key !~ '(^/|\.\.)')),
    CHECK (available_at IS NULL OR (available_at >= created_at AND available_at <= updated_at))
);

CREATE INDEX artifacts_task_created_idx
    ON zapvm.artifacts (tenant_id, project_id, task_id, created_sequence);
CREATE INDEX artifacts_scope_expiry_idx
    ON zapvm.artifacts (tenant_id, project_id, state, expires_at);
CREATE UNIQUE INDEX artifacts_object_key_unique
    ON zapvm.artifacts (object_key) WHERE object_key IS NOT NULL;

CREATE TABLE zapvm.scope_dispatch (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    dispatch_cursor bigint NOT NULL DEFAULT 0 CHECK (dispatch_cursor >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE zapvm.audit_records (
    sequence bigint PRIMARY KEY CHECK (sequence > 0),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    occurred_at timestamptz NOT NULL,
    action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9._-]{0,63}$'),
    tenant_id text,
    project_id text,
    node_id text,
    task_id text,
    operation_id text,
    artifact_id text,
    principal_sha256 bytea CHECK (principal_sha256 IS NULL OR octet_length(principal_sha256) = 32),
    outcome text NOT NULL CHECK (outcome ~ '^[a-z][a-z0-9._-]{0,127}$'),
    previous_sha256 bytea CHECK (previous_sha256 IS NULL OR octet_length(previous_sha256) = 32),
    sha256 bytea NOT NULL UNIQUE CHECK (octet_length(sha256) = 32),
    CHECK ((tenant_id IS NULL) = (project_id IS NULL)),
    CHECK (tenant_id IS NULL OR tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    CHECK (project_id IS NULL OR project_id ~ '^[a-z][a-z0-9._-]{0,127}$')
);

CREATE INDEX audit_scope_sequence_idx
    ON zapvm.audit_records (tenant_id, project_id, sequence)
    WHERE tenant_id IS NOT NULL;

ALTER TABLE zapvm.node_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.node_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computers ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computers FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.agent_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.task_events FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.workspace_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.workspace_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.scope_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.scope_dispatch FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.audit_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.audit_records FORCE ROW LEVEL SECURITY;

CREATE FUNCTION zapvm.can_bypass_rls() RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog
    RETURN current_setting('zapvm.bypass_rls', true) = 'on'
        AND pg_has_role(current_user, (SELECT nspowner FROM pg_namespace WHERE oid = 'zapvm'::regnamespace), 'USAGE');

CREATE POLICY node_scopes_tenant_isolation ON zapvm.node_scopes
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY computers_tenant_isolation ON zapvm.computers
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY sessions_tenant_isolation ON zapvm.agent_sessions
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY tasks_tenant_isolation ON zapvm.tasks
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY task_events_tenant_isolation ON zapvm.task_events
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY workspace_operations_tenant_isolation ON zapvm.workspace_operations
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY artifacts_tenant_isolation ON zapvm.artifacts
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY scope_dispatch_tenant_isolation ON zapvm.scope_dispatch
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY audit_records_tenant_isolation ON zapvm.audit_records
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
