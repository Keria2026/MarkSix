-- Additive upgrade: original bet rule/atom snapshots and accepted draws stay intact.
ALTER TABLE closing_configs ADD COLUMN open_time CHAR(5) NOT NULL DEFAULT '08:00';
ALTER TABLE periods ADD COLUMN open_time CHAR(5) NOT NULL DEFAULT '08:00';
ALTER TABLE bets
 ADD COLUMN bettor VARCHAR(80) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT '',
 ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
 ADD COLUMN void_stake BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN void_units INT NOT NULL DEFAULT 0,
 ADD INDEX ix_bets_bettor (period_id,bettor);
UPDATE plays SET rule=JSON_INSERT(rule,'$.compound_enabled',CAST('false' AS JSON));
CREATE TABLE layoffs (
 id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 bet_id CHAR(36) CHARACTER SET ascii NOT NULL,
 period_id CHAR(7) CHARACTER SET ascii NOT NULL,
 receiver VARCHAR(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
 amount BIGINT NOT NULL, unit_count INT NOT NULL,
 stake BIGINT NOT NULL, rebate BIGINT NOT NULL, exposure BIGINT NOT NULL,
 atoms JSON NOT NULL, results JSON NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'pending',
 payout BIGINT NULL, winning_stake BIGINT NULL,
 void_stake BIGINT NOT NULL DEFAULT 0, void_units INT NOT NULL DEFAULT 0,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 cancelled_at DATETIME(6) NULL,
 FOREIGN KEY(bet_id) REFERENCES bets(id), FOREIGN KEY(period_id) REFERENCES periods(id),
 INDEX ix_layoffs_bet (bet_id,status), INDEX ix_layoffs_period (period_id,status,receiver)
) ENGINE=InnoDB;
CREATE TABLE bet_mutations (
 request_id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 bet_id CHAR(36) CHARACTER SET ascii NOT NULL,
 request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 response JSON NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY(bet_id) REFERENCES bets(id)
) ENGINE=InnoDB;
-- Old extrema lack layoff/void semantics; queue only current unsettled periods.
UPDATE periods SET risk_status='queued',risk_result=NULL,risk_version=NULL,risk_requested_at=UTC_TIMESTAMP(6)
 WHERE state='pending';
