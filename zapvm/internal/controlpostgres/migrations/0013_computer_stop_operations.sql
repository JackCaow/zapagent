ALTER TABLE zapvm.computer_operations
    DROP CONSTRAINT computer_operations_kind_check,
    ADD CONSTRAINT computer_operations_kind_check CHECK (kind IN ('start', 'stop'));
