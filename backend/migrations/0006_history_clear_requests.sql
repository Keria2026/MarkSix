-- Append-only migration: do not alter the checksums of deployed migrations.
CREATE TABLE history_clear_requests (
 request_id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 cutoff DATE NOT NULL,
 response JSON NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
