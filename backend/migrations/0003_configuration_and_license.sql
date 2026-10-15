-- Logical deletion preserves references and immutable historical rule snapshots.
ALTER TABLE plays ADD COLUMN deleted_at DATETIME(6) NULL;
CREATE TABLE client_license (
    id TINYINT PRIMARY KEY,
    certificate JSON NULL,
    authority_url VARCHAR(512) NULL,
    last_seen_at BIGINT NOT NULL DEFAULT 0
);
INSERT INTO client_license(id) VALUES(1);
-- Only the separate authority uses these tables. No signing key is stored here.
CREATE TABLE license_codes (
    code_hash CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs PRIMARY KEY,
    valid_days INT NOT NULL,
    redeem_before BIGINT NOT NULL,
    redeemed_at BIGINT NULL,
    binding CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NULL,
    certificate JSON NULL
);
