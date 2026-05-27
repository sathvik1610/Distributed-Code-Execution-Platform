ALTER TABLE submission_results ADD COLUMN IF NOT EXISTS error_category VARCHAR(30);
ALTER TABLE submission_results ALTER COLUMN memory_used_bytes TYPE BIGINT;
