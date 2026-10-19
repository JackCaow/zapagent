ALTER TABLE zapvm.control_state
    ADD COLUMN credential_audit_sequence bigint NOT NULL DEFAULT 0 CHECK (credential_audit_sequence >= 0);

CREATE TABLE zapvm.credential_envelopes (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    credential_id text NOT NULL CHECK (credential_id ~ '^[A-Za-z][A-Za-z0-9._-]{0,63}$'),
    version bigint NOT NULL CHECK (version > 0),
    state text NOT NULL CHECK (state IN ('active', 'disabled', 'revoked')),
    envelope_schema integer NOT NULL CHECK (envelope_schema = 1),
    algorithm text NOT NULL CHECK (algorithm = 'AES-256-GCM'),
    kms_provider text NOT NULL CHECK (kms_provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'),
    kms_key_id text NOT NULL CHECK (octet_length(kms_key_id) BETWEEN 1 AND 2048 AND kms_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$'),
    kms_key_version text NOT NULL CHECK (octet_length(kms_key_version) BETWEEN 1 AND 256 AND kms_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$'),
    wrapped_data_key bytea NOT NULL CHECK (octet_length(wrapped_data_key) BETWEEN 1 AND 16384),
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 65552),
    aad_sha256 bytea NOT NULL CHECK (octet_length(aad_sha256) = 32),
    created_by_sha256 bytea NOT NULL CHECK (octet_length(created_by_sha256) = 32),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revoked_at timestamptz,
    PRIMARY KEY (tenant_id, project_id, credential_id, version),
    CHECK (updated_at >= created_at),
    CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX credential_envelopes_one_active
    ON zapvm.credential_envelopes (tenant_id, project_id, credential_id)
    WHERE state = 'active';

CREATE TABLE zapvm.credential_capabilities (
    capability_id text PRIMARY KEY CHECK (capability_id ~ '^[A-Za-z0-9._-]{16,128}$'),
    secret_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(secret_sha256) = 32),
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    task_id text NOT NULL,
    node_id text NOT NULL,
    node_generation text NOT NULL CHECK (node_generation ~ '^[A-Za-z0-9._-]{16,128}$'),
    state text NOT NULL CHECK (state IN ('issued', 'redeemed', 'revoked', 'expired')),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    redeemed_at timestamptz,
    revoked_at timestamptz,
    UNIQUE (tenant_id, project_id, capability_id),
    FOREIGN KEY (tenant_id, project_id, task_id)
        REFERENCES zapvm.tasks(tenant_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (node_id, tenant_id, project_id)
        REFERENCES zapvm.node_scopes(node_id, tenant_id, project_id) ON DELETE RESTRICT,
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
    CHECK ((state = 'redeemed') = (redeemed_at IS NOT NULL)),
    CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (redeemed_at IS NULL OR (redeemed_at >= issued_at AND redeemed_at <= expires_at)),
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX credential_capabilities_expiry_idx
    ON zapvm.credential_capabilities (state, expires_at)
    WHERE state = 'issued';
CREATE INDEX credential_capabilities_task_idx
    ON zapvm.credential_capabilities (tenant_id, project_id, task_id, issued_at);

CREATE TABLE zapvm.credential_capability_items (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    capability_id text NOT NULL,
    credential_id text NOT NULL,
    credential_version bigint NOT NULL,
    PRIMARY KEY (tenant_id, project_id, capability_id, credential_id),
    FOREIGN KEY (tenant_id, project_id, capability_id)
        REFERENCES zapvm.credential_capabilities(tenant_id, project_id, capability_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, project_id, credential_id, credential_version)
        REFERENCES zapvm.credential_envelopes(tenant_id, project_id, credential_id, version) ON DELETE RESTRICT
);

CREATE TABLE zapvm.credential_access_audit (
    sequence bigint PRIMARY KEY CHECK (sequence > 0),
    schema_version integer NOT NULL CHECK (schema_version = 1),
    occurred_at timestamptz NOT NULL,
    action text NOT NULL CHECK (action IN ('credential_create', 'credential_rotate', 'credential_disable', 'credential_revoke', 'capability_issue', 'capability_redeem', 'capability_revoke', 'capability_expire')),
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    credential_id text CHECK (credential_id IS NULL OR credential_id ~ '^[A-Za-z][A-Za-z0-9._-]{0,63}$'),
    credential_version bigint CHECK (credential_version IS NULL OR credential_version > 0),
    capability_id text CHECK (capability_id IS NULL OR capability_id ~ '^[A-Za-z0-9._-]{16,128}$'),
    task_id text,
    node_id text,
    node_generation text,
    principal_sha256 bytea NOT NULL CHECK (octet_length(principal_sha256) = 32),
    outcome text NOT NULL CHECK (outcome ~ '^[a-z][a-z0-9._-]{0,127}$'),
    previous_sha256 bytea CHECK (previous_sha256 IS NULL OR octet_length(previous_sha256) = 32),
    sha256 bytea NOT NULL UNIQUE CHECK (octet_length(sha256) = 32),
    CHECK ((credential_id IS NULL) = (credential_version IS NULL)),
    CHECK ((capability_id IS NULL) = (task_id IS NULL)),
    CHECK ((node_id IS NULL) = (node_generation IS NULL))
);

CREATE INDEX credential_access_audit_scope_sequence_idx
    ON zapvm.credential_access_audit (tenant_id, project_id, sequence);

ALTER TABLE zapvm.credential_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.credential_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.credential_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.credential_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.credential_capability_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.credential_capability_items FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.credential_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.credential_access_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY credential_envelopes_tenant_isolation ON zapvm.credential_envelopes
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY credential_capabilities_tenant_isolation ON zapvm.credential_capabilities
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY credential_capability_items_tenant_isolation ON zapvm.credential_capability_items
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
CREATE POLICY credential_access_audit_tenant_isolation ON zapvm.credential_access_audit
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
