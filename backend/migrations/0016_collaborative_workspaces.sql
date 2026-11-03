-- A new shared ledger never imports either member's private financial history.
CREATE TABLE hosted_workspaces (
 id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 database_name VARCHAR(64) CHARACTER SET ascii NOT NULL UNIQUE,
 database_user VARCHAR(32) CHARACTER SET ascii NOT NULL UNIQUE,
 database_password CHAR(64) CHARACTER SET ascii NOT NULL,
 state VARCHAR(20) NOT NULL DEFAULT 'provisioning',
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
ALTER TABLE hosted_accounts
 ADD COLUMN workspace_id CHAR(36) CHARACTER SET ascii NULL,
 ADD CONSTRAINT fk_account_workspace FOREIGN KEY(workspace_id) REFERENCES hosted_workspaces(id);
ALTER TABLE bets
 ADD COLUMN created_by CHAR(36) CHARACTER SET ascii NULL,
 ADD INDEX ix_bets_creator_date(created_by,entry_date,created_at);
