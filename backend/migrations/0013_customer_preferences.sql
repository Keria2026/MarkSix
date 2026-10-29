CREATE TABLE module_features (
    id TINYINT NOT NULL PRIMARY KEY,
    layoffs BOOLEAN NOT NULL DEFAULT FALSE,
    manual_entry BOOLEAN NOT NULL DEFAULT TRUE,
    text_entry BOOLEAN NOT NULL DEFAULT TRUE,
    entry_mode VARCHAR(6) NOT NULL DEFAULT 'manual',
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT chk_module_features_singleton CHECK (id = 1),
    CONSTRAINT chk_module_features_mode CHECK (entry_mode IN ('manual', 'text'))
);
INSERT INTO module_features(id) VALUES(1);

CREATE TABLE bettor_play_preferences (
    bettor VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    play_id BIGINT NOT NULL,
    amount_mode VARCHAR(16) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
