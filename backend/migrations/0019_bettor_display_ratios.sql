-- Shared customer names and presentation-only percentages, independent of the ledger.
CREATE TABLE bettor_display_ratios (
 bettor VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
 ratio INT NOT NULL DEFAULT 10000,
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 CONSTRAINT chk_bettor_display_ratio CHECK (ratio BETWEEN 0 AND 10000)
) ENGINE=InnoDB;
