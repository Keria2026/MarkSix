-- Fence each calculation independently of bet_version, including same-version retries.
ALTER TABLE periods ADD COLUMN risk_task_id CHAR(36) CHARACTER SET ascii NULL;
-- Risk results are derived caches. Older payloads lack the current net contract.
UPDATE periods SET risk_result=NULL,risk_version=NULL,risk_status=IF(state='pending','queued','stale'),risk_error=NULL,risk_requested_at=UTC_TIMESTAMP(6),risk_started_at=NULL,risk_finished_at=NULL;
