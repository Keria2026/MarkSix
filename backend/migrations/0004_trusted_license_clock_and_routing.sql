-- Keep prior migrations and existing certificates immutable. Process-local leases
-- are deliberately NOT persisted; restart always requires fresh authority time.
ALTER TABLE client_license
    ADD COLUMN discovery_url VARCHAR(512) NULL,
    ADD COLUMN route_revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN route_certificate JSON NULL;
ALTER TABLE license_codes
    ADD COLUMN redemption_id VARCHAR(36) NULL,
    ADD COLUMN intended_binding CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NULL,
    ADD COLUMN expires_at BIGINT NULL;
