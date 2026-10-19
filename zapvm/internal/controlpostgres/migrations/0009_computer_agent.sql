ALTER TABLE zapvm.computers
    ADD COLUMN agent text NOT NULL DEFAULT ''
    CHECK (agent = '' OR agent ~ '^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._+-]{1,128}$');
