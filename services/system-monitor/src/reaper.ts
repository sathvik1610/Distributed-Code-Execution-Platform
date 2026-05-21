/**
 * reaper.ts — Dead Worker Detection & Orphan Job Recovery
 *
 * This module is the heart of the System Monitor service. It runs on a
 * periodic interval and performs three critical reliability tasks:
 *
 * 1. HEARTBEAT SCAN
 *    Scans all `worker:heartbeat:*` keys in Redis. A worker that is alive
 *    refreshes this key with a 15-second TTL every 5 seconds. If the key
 *    is gone, the worker is considered dead.
 *
 * 2. DEAD WORKER DETECTION
 *    Discovers all known processing queues `jobs:queue:processing:*` and
 *    cross-references them against living heartbeats. Any processing queue
 *    with no matching heartbeat belongs to a dead worker.
 *
 * 3. ORPHAN JOB RECOVERY
 *    For each dead worker's queue, reads all stranded job payloads and
 *    either:
 *      a) Re-enqueues them with an incremented retryCount (if under MAX_RETRY)
 *      b) Routes them to the Dead Letter Queue (if over MAX_RETRY)
 *    Then deletes the now-empty dead worker's processing queue.
 */

import { redis } from './redis.js';
import { pool } from './db.js';
import { logger } from '@code-execution/logger';
import {
  deadWorkerRecoveries, deadLetterJobs
} from '@code-execution/metrics';
import {
  QueuePayload, DLQPayload, SubmissionStatus,
  QUEUE_KEYS, MAX_RETRY_COUNT
} from '@code-execution/contracts';

// ── Scanning Configuration ─────────────────────────────────────────────────

// Pattern to scan for all active processing queues
const PROCESSING_QUEUE_PATTERN = 'jobs:queue:processing:*';

// Pattern to scan for all active worker heartbeats
const HEARTBEAT_PATTERN = 'worker:heartbeat:*';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the workerId from a processing queue key.
 * Example: 'jobs:queue:processing:worker-abc123' -> 'worker-abc123'
 */
function extractWorkerIdFromQueue(queueKey: string): string {
  return queueKey.replace('jobs:queue:processing:', '');
}

/**
 * Extract the workerId from a heartbeat key.
 * Example: 'worker:heartbeat:worker-abc123' -> 'worker-abc123'
 */
function extractWorkerIdFromHeartbeat(heartbeatKey: string): string {
  return heartbeatKey.replace('worker:heartbeat:', '');
}

/**
 * Scan all Redis keys matching a pattern using SCAN (non-blocking).
 * Unlike KEYS, SCAN does not block the Redis event loop.
 */
async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== '0');

  return keys;
}

// ── DLQ Routing ────────────────────────────────────────────────────────────

async function sendToDLQ(job: QueuePayload, reason: string): Promise<void> {
  const dlqPayload: DLQPayload = {
    jobId: job.jobId,
    userId: job.userId,
    code: job.code,
    language: job.language,
    retryCount: job.retryCount,
    submittedAt: job.submittedAt,
    failedAt: new Date().toISOString(),
    reason
  };

  await redis.lpush(QUEUE_KEYS.DEAD_LETTER, JSON.stringify(dlqPayload));
  deadLetterJobs.inc();

  // Permanently mark the submission as FAILED
  await pool.query(
    `UPDATE submissions SET status = $1, updated_at = NOW() WHERE id = $2`,
    [SubmissionStatus.FAILED, job.jobId]
  );

  // Idempotently insert a failure result record
  await pool.query(
    `INSERT INTO submission_results (job_id, exit_code, stdout, stderr, error_message)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id) DO NOTHING`,
    [job.jobId, null, '', '', `Dead Letter: ${reason}`]
  );

  logger.error({ jobId: job.jobId, retryCount: job.retryCount, reason }, 'Orphan job sent to DLQ');
}

// ── Job Recovery ───────────────────────────────────────────────────────────

/**
 * Recover all jobs stranded in a dead worker's processing queue.
 * Each job is either requeued (with incremented retryCount) or DLQ'd.
 */
async function recoverJobsFromDeadWorker(deadWorkerId: string): Promise<void> {
  const processingQueueKey = QUEUE_KEYS.PROCESSING(deadWorkerId);

  logger.warn({ deadWorkerId, processingQueueKey }, 'Recovering orphan jobs from dead worker...');

  // Read all jobs still sitting in the dead worker's queue
  const rawJobs = await redis.lrange(processingQueueKey, 0, -1);

  if (rawJobs.length === 0) {
    logger.info({ deadWorkerId }, 'Dead worker had no orphan jobs. Cleaning up empty queue.');
    await redis.del(processingQueueKey);
    return;
  }

  logger.info({ deadWorkerId, orphanCount: rawJobs.length }, `Found ${rawJobs.length} orphan job(s) to recover`);

  for (const rawJob of rawJobs) {
    let job: QueuePayload;

    try {
      job = JSON.parse(rawJob) as QueuePayload;
    } catch (parseErr) {
      logger.error({ parseErr, rawJob }, 'Failed to parse orphan job payload. Skipping.');
      continue;
    }

    const nextRetry = job.retryCount + 1;

    if (nextRetry > MAX_RETRY_COUNT) {
      // Job has exhausted retries — route to Dead Letter Queue
      await sendToDLQ(job, `Worker ${deadWorkerId} died. Exceeded max retry count (${MAX_RETRY_COUNT}).`);
    } else {
      // Re-enqueue with incremented retryCount
      const requeued: QueuePayload = { ...job, retryCount: nextRetry };
      await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(requeued));

      // Reset status to PENDING in the database
      await pool.query(
        `UPDATE submissions
         SET status = $1, retry_count = $2, updated_at = NOW()
         WHERE id = $3`,
        [SubmissionStatus.PENDING, nextRetry, job.jobId]
      );

      deadWorkerRecoveries.inc();
      logger.info(
        { jobId: job.jobId, deadWorkerId, nextRetry },
        `Orphan job recovered — requeued (attempt ${nextRetry} of ${MAX_RETRY_COUNT})`
      );
    }
  }

  // Delete the now-empty processing queue
  await redis.del(processingQueueKey);
  logger.info({ deadWorkerId }, 'Dead worker processing queue deleted');
}

// ── Main Reaper Scan ───────────────────────────────────────────────────────

/**
 * Performs one full scan cycle:
 * 1. Finds all active processing queues.
 * 2. Finds all active worker heartbeats.
 * 3. Compares the two sets to identify dead workers.
 * 4. Recovers orphan jobs from dead workers.
 */
export async function runReaperScan(): Promise<void> {
  logger.info('Starting reaper scan...');

  try {
    // Scan all known processing queues
    const processingQueueKeys = await scanKeys(PROCESSING_QUEUE_PATTERN);
    const processingWorkerIds = new Set(
      processingQueueKeys.map(extractWorkerIdFromQueue)
    );

    // Scan all alive heartbeats
    const heartbeatKeys = await scanKeys(HEARTBEAT_PATTERN);
    const aliveWorkerIds = new Set(
      heartbeatKeys.map(extractWorkerIdFromHeartbeat)
    );

    logger.info(
      {
        totalProcessingQueues: processingWorkerIds.size,
        aliveWorkers: aliveWorkerIds.size
      },
      'Reaper scan: worker status summary'
    );

    // Find dead workers: have a processing queue but no heartbeat
    const deadWorkerIds: string[] = [];
    for (const workerId of processingWorkerIds) {
      if (!aliveWorkerIds.has(workerId)) {
        deadWorkerIds.push(workerId);
      }
    }

    if (deadWorkerIds.length === 0) {
      logger.info('Reaper scan: no dead workers found. All is well.');
      return;
    }

    logger.warn({ deadWorkerIds, count: deadWorkerIds.length }, 'Dead workers detected!');

    // Recover jobs from each dead worker
    for (const deadWorkerId of deadWorkerIds) {
      await recoverJobsFromDeadWorker(deadWorkerId);
    }

    logger.info({ recovered: deadWorkerIds.length }, 'Reaper scan complete');

  } catch (err) {
    logger.error(err, 'Reaper scan failed with unexpected error');
  }
}
