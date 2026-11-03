-- Account-owned configurations coexist with shared, immutable bet snapshots.
ALTER TABLE plays
 ADD COLUMN owner_account_id CHAR(36) CHARACTER SET ascii NULL,
 ADD INDEX ix_plays_owner(owner_account_id,deleted_at,sort_order,id);
ALTER TABLE text_entry_preferences
 ADD COLUMN owner_account_id CHAR(36) CHARACTER SET ascii NOT NULL DEFAULT '',
 DROP PRIMARY KEY,
 ADD PRIMARY KEY(owner_account_id,alias);
ALTER TABLE bettor_play_preferences
 ADD COLUMN owner_account_id CHAR(36) CHARACTER SET ascii NOT NULL DEFAULT '',
 DROP PRIMARY KEY,
 ADD PRIMARY KEY(owner_account_id,bettor);
CREATE TABLE account_play_initializations (
 account_id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 initialized_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
