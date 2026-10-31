-- Each market owns its draw and settlement period; legacy rows remain Macau.
ALTER TABLE bets DROP FOREIGN KEY bets_ibfk_1;
ALTER TABLE layoffs DROP FOREIGN KEY layoffs_ibfk_2;
ALTER TABLE bet_slips DROP FOREIGN KEY bet_slips_ibfk_1;
ALTER TABLE periods MODIFY id VARCHAR(20) CHARACTER SET ascii NOT NULL,
 DROP INDEX business_date,
 ADD COLUMN market VARCHAR(10) NOT NULL DEFAULT 'macau',
 ADD COLUMN previous_expect CHAR(7) CHARACTER SET ascii NULL,
 ADD UNIQUE INDEX ix_period_market_date(market,business_date);
ALTER TABLE bets MODIFY period_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
 ADD COLUMN market VARCHAR(10) NOT NULL DEFAULT 'macau',
 ADD CONSTRAINT bets_ibfk_1 FOREIGN KEY(period_id) REFERENCES periods(id);
ALTER TABLE layoffs MODIFY period_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
 ADD CONSTRAINT layoffs_ibfk_2 FOREIGN KEY(period_id) REFERENCES periods(id);
ALTER TABLE bet_slips MODIFY period_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
 ADD CONSTRAINT bet_slips_ibfk_1 FOREIGN KEY(period_id) REFERENCES periods(id);
ALTER TABLE audit_events MODIFY period_id VARCHAR(20) CHARACTER SET ascii NULL;
CREATE TABLE market_cursors (
 market VARCHAR(10) PRIMARY KEY, expect CHAR(7) CHARACTER SET ascii NOT NULL,
 open_time DATETIME NOT NULL
) ENGINE=InnoDB;
INSERT INTO market_cursors VALUES('hk','2026115','2026-10-27 21:32:32');
