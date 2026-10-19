ALTER TABLE zapvm.computers
    ADD COLUMN provisioning_source text NOT NULL DEFAULT 'config'
        CHECK (provisioning_source IN ('config', 'self_service'));

CREATE TABLE zapvm.workspace_members (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    user_id text NOT NULL CHECK (user_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    display_name text NOT NULL DEFAULT '' CHECK (octet_length(display_name) <= 256),
    email text NOT NULL DEFAULT '' CHECK (octet_length(email) <= 320),
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'member', 'viewer')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, user_id),
    CHECK (updated_at >= created_at)
);

CREATE TABLE zapvm.host_pools (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    pool_id text NOT NULL CHECK (pool_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 128),
    region text NOT NULL DEFAULT '' CHECK (octet_length(region) <= 128),
    enabled boolean NOT NULL DEFAULT true,
    max_computers integer NOT NULL DEFAULT 20 CHECK (max_computers BETWEEN 1 AND 4096),
    labels jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(labels) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, pool_id),
    CHECK (updated_at >= created_at)
);

CREATE TABLE zapvm.host_pool_nodes (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    pool_id text NOT NULL,
    node_id text NOT NULL REFERENCES zapvm.nodes(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, pool_id, node_id),
    FOREIGN KEY (tenant_id, project_id, pool_id)
        REFERENCES zapvm.host_pools(tenant_id, project_id, pool_id) ON DELETE CASCADE,
    FOREIGN KEY (node_id, tenant_id, project_id)
        REFERENCES zapvm.node_scopes(node_id, tenant_id, project_id) ON DELETE CASCADE
);

CREATE TABLE zapvm.model_profiles (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    model_id text NOT NULL CHECK (model_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 128),
    provider_url text NOT NULL CHECK (provider_url ~ '^https://'),
    provider_model text NOT NULL CHECK (octet_length(provider_model) BETWEEN 1 AND 256),
    credential_id text NOT NULL CHECK (credential_id ~ '^[A-Za-z][A-Za-z0-9._-]{0,63}$'),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, model_id),
    CHECK (updated_at >= created_at)
);

CREATE TABLE zapvm.agent_profiles (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 128),
    runtime_ref text NOT NULL CHECK (runtime_ref ~ '^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._+-]{1,128}$'),
    model_id text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, agent_id),
    FOREIGN KEY (tenant_id, project_id, model_id)
        REFERENCES zapvm.model_profiles(tenant_id, project_id, model_id) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at)
);

CREATE TABLE zapvm.computer_profiles (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    computer_id text NOT NULL,
    display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 128),
    pool_id text NOT NULL,
    agent_id text NOT NULL,
    vcpu integer NOT NULL DEFAULT 2 CHECK (vcpu BETWEEN 1 AND 128),
    memory_bytes bigint NOT NULL DEFAULT 4294967296 CHECK (memory_bytes BETWEEN 536870912 AND 1099511627776),
    browser_enabled boolean NOT NULL DEFAULT false,
    created_by text NOT NULL CHECK (created_by ~ '^[a-z][a-z0-9._-]{0,127}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, computer_id),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, project_id, pool_id)
        REFERENCES zapvm.host_pools(tenant_id, project_id, pool_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, agent_id)
        REFERENCES zapvm.agent_profiles(tenant_id, project_id, agent_id) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at)
);

CREATE TABLE zapvm.workspace_quotas (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    max_computers integer NOT NULL DEFAULT 10 CHECK (max_computers BETWEEN 1 AND 4096),
    max_concurrent_tasks integer NOT NULL DEFAULT 5 CHECK (max_concurrent_tasks BETWEEN 1 AND 1024),
    monthly_task_seconds bigint NOT NULL DEFAULT 360000 CHECK (monthly_task_seconds BETWEEN 60 AND 2678400000),
    artifact_bytes bigint NOT NULL DEFAULT 107374182400 CHECK (artifact_bytes BETWEEN 5368709120 AND 10995116277760),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id)
);

CREATE INDEX workspace_members_scope_role_idx ON zapvm.workspace_members (tenant_id, project_id, role, status);
CREATE INDEX computer_profiles_pool_idx ON zapvm.computer_profiles (tenant_id, project_id, pool_id);

ALTER TABLE zapvm.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.workspace_members FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.host_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.host_pools FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.host_pool_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.host_pool_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.model_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.model_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.agent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.agent_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computer_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE zapvm.workspace_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.workspace_quotas FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_members_tenant_isolation ON zapvm.workspace_members
    USING (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)))
    WITH CHECK (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)));
CREATE POLICY host_pools_tenant_isolation ON zapvm.host_pools
    USING (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)))
    WITH CHECK (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)));
CREATE POLICY host_pool_nodes_tenant_isolation ON zapvm.host_pool_nodes
    USING (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)))
    WITH CHECK (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)));
CREATE POLICY model_profiles_tenant_isolation ON zapvm.model_profiles
    USING (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)))
    WITH CHECK (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)));
CREATE POLICY agent_profiles_tenant_isolation ON zapvm.agent_profiles
    USING (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)))
    WITH CHECK (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)));
CREATE POLICY computer_profiles_tenant_isolation ON zapvm.computer_profiles
    USING (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)))
    WITH CHECK (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)));
CREATE POLICY workspace_quotas_tenant_isolation ON zapvm.workspace_quotas
    USING (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)))
    WITH CHECK (zapvm.can_bypass_rls() OR (tenant_id=current_setting('zapvm.tenant_id',true) AND project_id=current_setting('zapvm.project_id',true)));
