CREATE TABLE zapvm.computer_nodes (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    node_id text NOT NULL CHECK (node_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    PRIMARY KEY (tenant_id, project_id, computer_id, node_id),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE CASCADE,
    FOREIGN KEY (node_id, tenant_id, project_id)
        REFERENCES zapvm.node_scopes(node_id, tenant_id, project_id) ON DELETE CASCADE
);

INSERT INTO zapvm.computer_nodes (tenant_id, project_id, computer_id, node_id)
SELECT tenant_id, project_id, computer_id, node_id FROM zapvm.computers;

ALTER TABLE zapvm.computers
    DROP CONSTRAINT computers_node_id_tenant_id_project_id_fkey,
    DROP COLUMN node_id,
    ALTER COLUMN created_at DROP NOT NULL;

ALTER TABLE zapvm.computer_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computer_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY computer_nodes_tenant_isolation ON zapvm.computer_nodes
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));

ALTER TABLE zapvm.artifacts
    DROP CONSTRAINT artifacts_registered_node_id_tenant_id_project_id_fkey,
    ADD FOREIGN KEY (registered_node_id) REFERENCES zapvm.nodes(id) ON DELETE RESTRICT;

CREATE TABLE zapvm.file_mirror_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    snapshot_format_version integer NOT NULL CHECK (snapshot_format_version > 0),
    source_state_schema_version integer NOT NULL CHECK (source_state_schema_version > 0),
    source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
    database_sha256 bytea NOT NULL CHECK (octet_length(database_sha256) = 32),
    row_counts jsonb NOT NULL CHECK (jsonb_typeof(row_counts) = 'object'),
    imported_at timestamptz NOT NULL
);
