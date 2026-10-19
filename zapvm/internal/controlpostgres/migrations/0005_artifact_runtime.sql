ALTER TABLE zapvm.artifacts
    DROP CONSTRAINT artifacts_check2;

ALTER TABLE zapvm.artifacts
    ADD CONSTRAINT artifacts_upload_state_check CHECK (
        (state = 'available' AND object_key IS NOT NULL AND available_at IS NOT NULL)
        OR (state = 'expired' AND (object_key IS NOT NULL OR available_at IS NULL))
        OR (state IN ('pending', 'failed') AND available_at IS NULL)
    );
