CREATE TABLE administrators (
 id TINYINT PRIMARY KEY, username VARCHAR(80) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE sessions (
 token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY, expires_at DATETIME(6) NOT NULL,
 INDEX ix_sessions_expiry(expires_at)
) ENGINE=InnoDB;
CREATE TABLE closing_configs (
 effective_date DATE PRIMARY KEY, close_time CHAR(5) NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
CREATE TABLE mapping_configs (
 effective_date DATE PRIMARY KEY, mapping JSON NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
CREATE TABLE plays (
 id BIGINT PRIMARY KEY AUTO_INCREMENT, version BIGINT NOT NULL,
 rule JSON NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
CREATE TABLE play_versions (
 play_id BIGINT NOT NULL, version BIGINT NOT NULL, rule JSON NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(play_id,version), FOREIGN KEY(play_id) REFERENCES plays(id)
) ENGINE=InnoDB;
CREATE TABLE periods (
 id CHAR(7) CHARACTER SET ascii PRIMARY KEY, business_date DATE NOT NULL UNIQUE,
 close_time CHAR(5) NOT NULL, mapping JSON NOT NULL,
 state VARCHAR(20) NOT NULL DEFAULT 'pending',
 bet_version BIGINT NOT NULL DEFAULT 0,
 draw JSON NULL, raw_draw JSON NULL, draw_accepted_at DATETIME(6) NULL,
 last_fetch_at DATETIME(6) NULL, error TEXT NULL, mapping_warning BOOLEAN NOT NULL DEFAULT FALSE,
 settled_at DATETIME(6) NULL,
 risk_status VARCHAR(20) NOT NULL DEFAULT 'queued', risk_version BIGINT NULL,
 risk_result JSON NULL, risk_error TEXT NULL, risk_started_at DATETIME(6) NULL,
 risk_requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 risk_finished_at DATETIME(6) NULL,
 INDEX ix_period_pending(state,business_date)
) ENGINE=InnoDB;
CREATE TABLE bets (
 id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 request_id CHAR(36) CHARACTER SET ascii NOT NULL UNIQUE,
 request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 period_id CHAR(7) CHARACTER SET ascii NOT NULL,
 play_id BIGINT NOT NULL, play_version BIGINT NOT NULL, rule JSON NOT NULL,
 selections JSON NOT NULL, compound BOOLEAN NOT NULL,
 amount BIGINT NOT NULL, unit_count INT NOT NULL,
 stake BIGINT NOT NULL, rebate BIGINT NOT NULL, exposure BIGINT NOT NULL,
 natal TINYINT NOT NULL, atoms JSON NOT NULL, results JSON NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'pending',
 payout BIGINT NULL, winning_stake BIGINT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), cancelled_at DATETIME(6) NULL,
 FOREIGN KEY(period_id) REFERENCES periods(id), FOREIGN KEY(play_id) REFERENCES plays(id),
 INDEX ix_bets_period_status(period_id,status), INDEX ix_bets_created(period_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE audit_events (
 id BIGINT PRIMARY KEY AUTO_INCREMENT, period_id CHAR(7) CHARACTER SET ascii NULL,
 event VARCHAR(40) NOT NULL, detail JSON NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 INDEX ix_audit_period(period_id,id)
) ENGINE=InnoDB;
