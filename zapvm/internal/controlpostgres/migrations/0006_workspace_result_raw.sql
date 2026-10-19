ALTER TABLE zapvm.workspace_operations
    ADD COLUMN result_raw bytea CHECK (result_raw IS NULL OR octet_length(result_raw) BETWEEN 2 AND 1048576);

DO $zapvm_workspace_result_raw$
BEGIN
    IF EXISTS (SELECT 1 FROM zapvm.workspace_operations WHERE state = 'succeeded') THEN
        RAISE EXCEPTION 'successful workspace operations must expire or be re-imported before adding immutable result bytes';
    END IF;
END;
$zapvm_workspace_result_raw$;

ALTER TABLE zapvm.workspace_operations
    ADD CONSTRAINT workspace_result_raw_state_check CHECK ((state = 'succeeded') = (result_raw IS NOT NULL));
