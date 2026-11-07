-- Presentation-only offsets. Financial snapshots and ledger revisions are untouched.
CREATE TABLE received_display_states (
 period_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
 view_creator CHAR(36) CHARACTER SET ascii NOT NULL DEFAULT '',
 market VARCHAR(10) CHARACTER SET ascii NOT NULL,
 revision BIGINT NOT NULL DEFAULT 0,
 deductions JSON NOT NULL,
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(period_id,view_creator,market),
 FOREIGN KEY(period_id) REFERENCES periods(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE received_display_changes (
 request_id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 period_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
 snapshot JSON NOT NULL,
 response JSON NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY(period_id) REFERENCES periods(id) ON DELETE CASCADE,
 INDEX ix_received_display_changes(period_id,created_at)
) ENGINE=InnoDB;
