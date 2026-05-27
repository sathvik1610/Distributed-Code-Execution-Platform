-- Database Schema for Distributed Sandboxed Code Execution Platform
-- Version: 3.0 — Adds error_category for fine-grained failure classification

-- ============================================================
-- Table: submissions
-- Stores metadata and current state for each code submission.
-- ============================================================
CREATE TABLE IF NOT EXISTS submissions (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36),
    language    VARCHAR(20)  NOT NULL,
    source_code TEXT         NOT NULL,
    status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    retry_count INT          NOT NULL DEFAULT 0,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_status CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT'))
);

-- ============================================================
-- Table: submission_results
-- Stores execution output and metrics separately for idempotency.
-- UNIQUE(job_id) ensures ON CONFLICT DO NOTHING works on retries.
-- error_category provides fine-grained failure classification:
--   SYNTAX_ERROR  — interpreter reported syntax/indentation error
--   RUNTIME_ERROR — non-zero exit for other reasons
--   OOM           — exit 137 without timeout (OOM killer)
--   TIMEOUT       — killed by our 5-second timeout timer
--   WORKER_CRASH  — job recovered from a dead worker (DLQ path)
--   UNKNOWN       — catch-all
-- ============================================================
CREATE TABLE IF NOT EXISTS submission_results (
    id                SERIAL PRIMARY KEY,
    job_id            VARCHAR(36) NOT NULL,
    exit_code         INT,
    stdout            TEXT DEFAULT '',
    stderr            TEXT DEFAULT '',
    error_message     TEXT,
    error_category    VARCHAR(30),
    execution_time_ms INT,
    memory_used_bytes BIGINT,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_submission_results_job_id UNIQUE (job_id),
    CONSTRAINT fk_submission_results_job_id FOREIGN KEY (job_id) REFERENCES submissions(id),
    CONSTRAINT chk_error_category CHECK (
      error_category IS NULL OR
      error_category IN ('SYNTAX_ERROR', 'RUNTIME_ERROR', 'OOM', 'TIMEOUT', 'WORKER_CRASH', 'UNKNOWN')
    )
);

-- ============================================================
-- Indexes
-- ============================================================

-- Filter by user + status (history queries)
CREATE INDEX IF NOT EXISTS idx_submissions_user_id_status
    ON submissions(user_id, status);

-- Pagination and time-ordered queries
CREATE INDEX IF NOT EXISTS idx_submissions_created_at
    ON submissions(created_at DESC);

-- Status-only queries (worker polling, monitor scanning)
CREATE INDEX IF NOT EXISTS idx_submissions_status
    ON submissions(status);

-- Look up results by job (most common worker path)
CREATE INDEX IF NOT EXISTS idx_submission_results_job_id
    ON submission_results(job_id);

-- ============================================================
-- Migration helper (for existing databases)
-- Run this if upgrading from schema v2.0:
--   ALTER TABLE submission_results ADD COLUMN IF NOT EXISTS error_category VARCHAR(30);
--   ALTER TABLE submission_results ALTER COLUMN memory_used_bytes TYPE BIGINT;
-- ============================================================
