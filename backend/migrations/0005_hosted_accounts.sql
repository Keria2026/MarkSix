-- Hosted Dev1.0 control plane. Legacy business tables remain unchanged.
CREATE TABLE hosted_accounts (
 id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 username VARCHAR(80) COLLATE utf8mb4_0900_as_cs NOT NULL UNIQUE,
 password_hash VARCHAR(255) NOT NULL,
 credential_version BIGINT NOT NULL DEFAULT 1,
 permanent BOOLEAN NOT NULL DEFAULT FALSE,
 authorized_through DATE NULL,
 disabled BOOLEAN NOT NULL DEFAULT FALSE,
 state VARCHAR(20) NOT NULL DEFAULT 'provisioning',
 database_name VARCHAR(64) CHARACTER SET ascii NOT NULL UNIQUE,
 database_user VARCHAR(32) CHARACTER SET ascii NOT NULL UNIQUE,
 database_password CHAR(64) CHARACTER SET ascii NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
CREATE TABLE hosted_sessions (
 token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY,
 account_id CHAR(36) CHARACTER SET ascii NOT NULL UNIQUE,
 credential_version BIGINT NOT NULL,
 expires_at DATETIME(6) NOT NULL,
 FOREIGN KEY(account_id) REFERENCES hosted_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE hosted_codes (
 id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 token_hash CHAR(64) CHARACTER SET ascii NOT NULL UNIQUE,
 account_id CHAR(36) CHARACTER SET ascii NOT NULL,
 credential_version BIGINT NOT NULL,
 days INT NOT NULL,
 redeem_through DATE NOT NULL,
 redeemed_at DATETIME(6) NULL,
 redemption_id CHAR(36) CHARACTER SET ascii NULL,
 granted_through DATE NULL,
 revoked_at DATETIME(6) NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 FOREIGN KEY(account_id) REFERENCES hosted_accounts(id) ON DELETE CASCADE,
 INDEX ix_hosted_codes_account(account_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE authority_administrators (
 id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 username VARCHAR(80) COLLATE utf8mb4_0900_as_cs NOT NULL UNIQUE,
 password_hash VARCHAR(255) NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
CREATE TABLE authority_sessions (
 token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY,
 administrator_id CHAR(36) CHARACTER SET ascii NOT NULL,
 expires_at DATETIME(6) NOT NULL,
 FOREIGN KEY(administrator_id) REFERENCES authority_administrators(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE authority_audit (
 id BIGINT PRIMARY KEY AUTO_INCREMENT,
 administrator_id CHAR(36) CHARACTER SET ascii NULL,
 account_id CHAR(36) CHARACTER SET ascii NULL,
 event VARCHAR(40) NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
-- Opaque deletion receipts survive backup restore and contain no credentials or names.
CREATE TABLE hosted_deletions (
 account_id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 deleted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
