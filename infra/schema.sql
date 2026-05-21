-- Database Schema for Distributed Sandboxed Code Execution Platform
-- Version: 2.0 — Production-grade with idempotency, constraints, and result tables

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
-- ============================================================
CREATE TABLE IF NOT EXISTS submission_results (
    id                SERIAL PRIMARY KEY,
    job_id            VARCHAR(36) NOT NULL,
    exit_code         INT,
    stdout            TEXT DEFAULT '',
    stderr            TEXT DEFAULT '',
    error_message     TEXT,
    execution_time_ms INT,
    memory_used_bytes INT,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_submission_results_job_id UNIQUE (job_id),
    CONSTRAINT fk_submission_results_job_id FOREIGN KEY (job_id) REFERENCES submissions(id)
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
