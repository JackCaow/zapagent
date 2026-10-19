CREATE TABLE zapvm.primary_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation bigint NOT NULL CHECK (generation > 0),
    snapshot bytea NOT NULL CHECK (octet_length(snapshot) BETWEEN 2 AND 68157440),
    source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
    database_sha256 bytea NOT NULL CHECK (octet_length(database_sha256) = 32),
    committed_at timestamptz NOT NULL
);
