-- Presentation ordering is independent of financial rule versions.
ALTER TABLE plays ADD COLUMN sort_order BIGINT NOT NULL DEFAULT 9223372036854775807;
UPDATE plays SET sort_order=id;

-- A slip groups independent bet snapshots; settlement and layoffs stay on each bet.
CREATE TABLE bet_slips (
 id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 request_id CHAR(36) CHARACTER SET ascii NOT NULL UNIQUE,
 request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 period_id CHAR(7) CHARACTER SET ascii NOT NULL,
 bettor VARCHAR(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY(period_id) REFERENCES periods(id),
 INDEX ix_slips_period(period_id,created_at)
) ENGINE=InnoDB;
ALTER TABLE bets
 ADD COLUMN slip_id CHAR(36) CHARACTER SET ascii NULL,
 ADD COLUMN slip_position INT NULL,
 ADD FOREIGN KEY(slip_id) REFERENCES bet_slips(id),
 ADD UNIQUE INDEX ix_bets_slip_position(slip_id,slip_position);
