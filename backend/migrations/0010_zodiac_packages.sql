-- Snapshot package intent; existing ordinary bets retain their original semantics.
ALTER TABLE bets ADD COLUMN package_zodiacs JSON NULL;
