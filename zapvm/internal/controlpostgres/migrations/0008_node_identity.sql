ALTER TABLE zapvm.control_state
    ADD COLUMN node_identity_audit_sequence bigint NOT NULL DEFAULT 0 CHECK (node_identity_audit_sequence >= 0);

CREATE TABLE zapvm.node_enrollment_tokens (
    node_id text PRIMARY KEY REFERENCES zapvm.nodes(id) ON DELETE CASCADE,
    token_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
    state text NOT NULL CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 days'),
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
    CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at <= expires_at)),
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX node_enrollment_tokens_expiry_idx
    ON zapvm.node_enrollment_tokens (state, expires_at)
    WHERE state = 'active';

CREATE TABLE zapvm.node_certificates (
    serial_hex text PRIMARY KEY CHECK (serial_hex ~ '^[a-f0-9]{32}$'),
    node_id text NOT NULL REFERENCES zapvm.nodes(id) ON DELETE CASCADE,
    public_key_sha256 bytea NOT NULL CHECK (octet_length(public_key_sha256) = 32),
    state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
    issued_at timestamptz NOT NULL,
    not_before timestamptz NOT NULL,
    not_after timestamptz NOT NULL,
    renewed_from_serial_hex text REFERENCES zapvm.node_certificates(serial_hex) ON DELETE RESTRICT,
    revoked_at timestamptz,
    CHECK (not_before <= issued_at AND issued_at < not_after),
    CHECK (not_after <= issued_at + interval '24 hours'),
    CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
    CHECK (renewed_from_serial_hex IS NULL OR renewed_from_serial_hex <> serial_hex)
);

CREATE UNIQUE INDEX node_certificates_node_public_key_active_idx
    ON zapvm.node_certificates (node_id, public_key_sha256)
    WHERE state = 'active';
CREATE INDEX node_certificates_node_state_expiry_idx
    ON zapvm.node_certificates (node_id, state, not_after);

CREATE TABLE zapvm.node_identity_audit (
    sequence bigint PRIMARY KEY CHECK (sequence > 0),
    schema_version integer NOT NULL CHECK (schema_version = 1),
    occurred_at timestamptz NOT NULL,
    action text NOT NULL CHECK (action IN ('token_provision', 'token_revoke', 'token_expire', 'certificate_enroll', 'certificate_renew', 'certificate_revoke', 'certificate_expire')),
    node_id text NOT NULL REFERENCES zapvm.nodes(id) ON DELETE RESTRICT,
    serial_hex text CHECK (serial_hex IS NULL OR serial_hex ~ '^[a-f0-9]{32}$'),
    principal_sha256 bytea NOT NULL CHECK (octet_length(principal_sha256) = 32),
    outcome text NOT NULL CHECK (outcome ~ '^[a-z][a-z0-9._-]{0,127}$'),
    previous_sha256 bytea CHECK (previous_sha256 IS NULL OR octet_length(previous_sha256) = 32),
    sha256 bytea NOT NULL UNIQUE CHECK (octet_length(sha256) = 32)
);

CREATE INDEX node_identity_audit_node_sequence_idx
    ON zapvm.node_identity_audit (node_id, sequence);
