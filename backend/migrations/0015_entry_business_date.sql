-- Reporting dates are independent of each market's settlement period.
ALTER TABLE bets ADD COLUMN entry_date DATE NULL;
UPDATE bets b
JOIN periods p ON p.id=b.period_id
LEFT JOIN bet_slips s ON s.id=b.slip_id
LEFT JOIN periods anchor ON anchor.id=s.period_id
SET b.entry_date=CASE
 WHEN p.market='macau' THEN p.business_date
 WHEN anchor.market='macau' THEN anchor.business_date
 ELSE DATE(DATE_ADD(b.created_at,INTERVAL 2 HOUR)) END;
ALTER TABLE bets MODIFY entry_date DATE NOT NULL,
 ADD INDEX ix_bets_entry_date(entry_date,created_at,id);
