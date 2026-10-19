CREATE TABLE zapvm.node_resources (
    node_id text PRIMARY KEY REFERENCES zapvm.nodes(id) ON DELETE CASCADE,
    report_generation bigint NOT NULL DEFAULT 0 CHECK (report_generation >= 0),
    architecture text NOT NULL DEFAULT 'unknown'
        CHECK (architecture IN ('unknown', 'amd64', 'arm64')),
    region text NOT NULL DEFAULT '' CHECK (octet_length(region) <= 128),
    total_vcpu integer NOT NULL CHECK (total_vcpu BETWEEN 1 AND 65536),
    allocatable_vcpu integer NOT NULL CHECK (allocatable_vcpu BETWEEN 1 AND total_vcpu),
    reserved_vcpu integer NOT NULL DEFAULT 0 CHECK (reserved_vcpu BETWEEN 0 AND total_vcpu - allocatable_vcpu),
    total_memory_bytes bigint NOT NULL DEFAULT 0 CHECK (total_memory_bytes >= 0),
    allocatable_memory_bytes bigint NOT NULL DEFAULT 0
        CHECK (allocatable_memory_bytes BETWEEN 0 AND total_memory_bytes),
    reserved_memory_bytes bigint NOT NULL DEFAULT 0
        CHECK (reserved_memory_bytes BETWEEN 0 AND total_memory_bytes - allocatable_memory_bytes),
    vm_slots integer NOT NULL CHECK (vm_slots BETWEEN 1 AND 1024),
    browser_slots integer NOT NULL DEFAULT 0 CHECK (browser_slots BETWEEN 0 AND 1024),
    starting_count integer NOT NULL DEFAULT 0 CHECK (starting_count BETWEEN 0 AND vm_slots),
    running_count integer NOT NULL DEFAULT 0 CHECK (running_count BETWEEN 0 AND vm_slots),
    labels jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(labels) = 'object'),
    cached_image_digests text[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(cached_image_digests) <= 256),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (starting_count + running_count <= vm_slots)
);

INSERT INTO zapvm.node_resources
    (node_id,total_vcpu,allocatable_vcpu,vm_slots)
SELECT id,capacity,capacity,capacity FROM zapvm.nodes;

CREATE TABLE zapvm.computer_placements (
    tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9._-]{0,127}$'),
    computer_id text NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9._-]{1,128}$'),
    epoch bigint NOT NULL CHECK (epoch > 0),
    node_id text NOT NULL REFERENCES zapvm.nodes(id) ON DELETE RESTRICT,
    node_generation text NOT NULL CHECK (node_generation ~ '^[A-Za-z0-9._-]{16,128}$'),
    state text NOT NULL CHECK (state IN ('ready', 'released', 'failed')),
    reason text NOT NULL DEFAULT 'scheduler'
        CHECK (reason ~ '^[a-z][a-z0-9_-]{0,63}$'),
    created_at timestamptz NOT NULL,
    ready_at timestamptz,
    released_at timestamptz,
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
    PRIMARY KEY (tenant_id, project_id, computer_id, epoch),
    FOREIGN KEY (tenant_id, project_id, computer_id)
        REFERENCES zapvm.computers(tenant_id, project_id, computer_id) ON DELETE CASCADE,
    CHECK ((state = 'ready') = (ready_at IS NOT NULL AND released_at IS NULL AND failure_code IS NULL)),
    CHECK ((state IN ('released', 'failed')) = (released_at IS NOT NULL)),
    CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

CREATE UNIQUE INDEX computer_placements_active_unique
    ON zapvm.computer_placements (tenant_id, project_id, computer_id)
    WHERE state = 'ready';

CREATE INDEX computer_placements_node_active_idx
    ON zapvm.computer_placements (node_id, state, created_at)
    WHERE state = 'ready';

ALTER TABLE zapvm.tasks
    ADD COLUMN placement_epoch bigint CHECK (placement_epoch IS NULL OR placement_epoch > 0),
    ADD FOREIGN KEY (tenant_id, project_id, computer_id, placement_epoch)
        REFERENCES zapvm.computer_placements(tenant_id, project_id, computer_id, epoch)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE zapvm.computer_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE zapvm.computer_placements FORCE ROW LEVEL SECURITY;
CREATE POLICY computer_placements_tenant_isolation ON zapvm.computer_placements
    USING (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)))
    WITH CHECK (zapvm.can_bypass_rls() OR
        (tenant_id = current_setting('zapvm.tenant_id', true) AND project_id = current_setting('zapvm.project_id', true)));
