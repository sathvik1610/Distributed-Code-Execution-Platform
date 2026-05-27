import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { pool } from './db.js';
import { redis, redisPub } from './redis.js';
import { logger } from '@code-execution/logger';
import {
  startMetricsServer, activeWorkers, workerJobCounter,
  executionDuration, deadLetterJobs, queueWaitTime
} from '@code-execution/metrics';
import {
  SubmissionStatus, QueuePayload, DLQPayload,
  QUEUE_KEYS, MAX_RETRY_COUNT
} from '@code-execution/contracts';
import { runInSandbox } from './sandbox.js';

const workerId = `worker-${uuidv4()}`;
let shouldRun = true;

logger.info({ workerId }, 'Starting execution worker instance');

// ──────────────────────────────────────────────────────────
// Heartbeat
// Publishes a TTL key every 5s. System Monitor uses this to
// detect dead workers and recover abandoned jobs.
// ──────────────────────────────────────────────────────────
async function sendHeartbeat() {
  try {
    await redis.set(QUEUE_KEYS.HEARTBEAT(workerId), 'alive', 'EX', 15);
  } catch (err) {
    logger.error(err, 'Failed to send heartbeat to Redis');
  }
}

// ──────────────────────────────────────────────────────────
// Exponential Backoff
// Waits 2^retryCount seconds before the job is retried.
// Prevents thundering herd during transient failures.
// ──────────────────────────────────────────────────────────
function backoffMs(retryCount: number): number {
  return Math.pow(2, retryCount) * 1000;
}

// ──────────────────────────────────────────────────────────
// Send to Dead Letter Queue
// Called when a job has exhausted MAX_RETRY_COUNT attempts.
// Persists the job to 'jobs:queue:dead-letter' and marks
// the DB row as FAILED with a clear error message.
// ──────────────────────────────────────────────────────────
async function sendToDLQ(job: QueuePayload, reason: string) {
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

  // Mark the submission as permanently FAILED in the database
  await pool.query(
    `UPDATE submissions SET status = $1, updated_at = NOW() WHERE id = $2`,
    [SubmissionStatus.FAILED, job.jobId]
  );

  // Store a result record for the DLQ failure (idempotent — skip if already exists)
  await pool.query(
    `INSERT INTO submission_results (job_id, exit_code, stdout, stderr, error_message, error_category)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO NOTHING`,
    [job.jobId, null, '', '', `Dead Letter: ${reason}`, 'WORKER_CRASH']
  );

  logger.error({ jobId: job.jobId, retryCount: job.retryCount, reason }, 'Job moved to Dead Letter Queue');

  // Publish EXECUTION_COMPLETE system signal for DLQ failure so active WebSocket closes cleanly
  const completeChunk = {
    type: 'system',
    data: 'EXECUTION_COMPLETE',
    timestamp: Date.now()
  };
  await redisPub.publish('jobs:streams:' + job.jobId, JSON.stringify(completeChunk));
}

// ──────────────────────────────────────────────────────────
// Requeue with Backoff
// Increments retryCount, waits the backoff delay, then pushes
// the job back to the pending queue.
// ──────────────────────────────────────────────────────────
async function requeueWithBackoff(job: QueuePayload, processingQueue: string, rawJob: string) {
  const nextRetry = job.retryCount + 1;

  if (nextRetry > MAX_RETRY_COUNT) {
    await redis.lrem(processingQueue, 1, rawJob);
    await sendToDLQ(job, `Exceeded maximum retry count of ${MAX_RETRY_COUNT}`);
    return;
  }

  const delay = backoffMs(nextRetry);
  logger.warn(
    { jobId: job.jobId, nextRetry, delayMs: delay },
    `Requeueing job with backoff (attempt ${nextRetry} of ${MAX_RETRY_COUNT})`
  );

  // Update retry_count in the database
  await pool.query(
    `UPDATE submissions SET retry_count = $1, status = $2, updated_at = NOW() WHERE id = $3`,
    [nextRetry, SubmissionStatus.PENDING, job.jobId]
  );

  // Wait the backoff period before re-enqueuing
  await new Promise(resolve => setTimeout(resolve, delay));

  const updatedPayload: QueuePayload = { ...job, retryCount: nextRetry };
  await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(updatedPayload));
  await redis.lrem(processingQueue, 1, rawJob);

  logger.info({ jobId: job.jobId, nextRetry }, 'Job requeued after backoff');
}

// ──────────────────────────────────────────────────────────
// Main Execution Loop
// Polls the Redis queue, executes jobs in Docker sandboxes,
// persists results, and handles failures with idempotency.
// ──────────────────────────────────────────────────────────
async function processQueue() {
  activeWorkers.inc();

  await sendHeartbeat();
  const heartbeatInterval = setInterval(sendHeartbeat, 5000);

  const processingQueue = QUEUE_KEYS.PROCESSING(workerId);

  while (shouldRun) {
    let rawJob: string | null = null;
    let job: QueuePayload | null = null;

    try {
      // BRPOPLPUSH atomically moves job from pending -> processing:{workerId}
      // This is crash-safe: if the worker dies, the System Monitor can recover it
      rawJob = await redis.brpoplpush(QUEUE_KEYS.PENDING, processingQueue, 2);

      if (!rawJob) {
        continue;
      }

      job = JSON.parse(rawJob) as QueuePayload;
      logger.info({ jobId: job.jobId, retryCount: job.retryCount }, 'Dequeued job for processing');

      // ── State-machine transition lock ───────────────────
      // Only process if the job is in PENDING state.
      // Guards against duplicate processing on retry races.
      const dbResult = await pool.query(
        `UPDATE submissions
         SET status = $1, updated_at = NOW()
         WHERE id = $2 AND status = $3
         RETURNING status`,
        [SubmissionStatus.RUNNING, job.jobId, SubmissionStatus.PENDING]
      );

      if (dbResult.rows.length === 0) {
        logger.warn({ jobId: job.jobId }, 'Job already claimed, processed, or in invalid state. Skipping.');
        await redis.lrem(processingQueue, 1, rawJob);
        continue;
      }

      // ── Record queue wait time ──────────────────────────
      // Time from client submission to worker pickup. Distinct from execution
      // time — a spike here means worker starvation (add more workers).
      const queueWaitMs = Date.now() - Date.parse(job.submittedAt);
      queueWaitTime.observe({ language: job.language }, queueWaitMs);
      logger.info({ jobId: job.jobId, queueWaitMs }, 'Queue wait recorded');

      // ── Execute in Docker sandbox ───────────────────────
      const result = await runInSandbox(job.jobId, job.code, job.language);

      // ── Determine final status ──────────────────────────
      let finalStatus = SubmissionStatus.COMPLETED;
      let errorMessage: string | null = null;
      let errorCategory: string | null = null;

      if (result.timedOut) {
        finalStatus = SubmissionStatus.TIMEOUT;
        errorMessage = 'Execution timed out (limit: 5 seconds)';
        errorCategory = 'TIMEOUT';
      } else if (result.outputCapReached) {
        finalStatus = SubmissionStatus.FAILED;
        errorMessage = 'Output limit exceeded (limit: 1 MB)';
        errorCategory = 'RUNTIME_ERROR';
      } else if (result.oomKilled) {
        finalStatus = SubmissionStatus.FAILED;
        errorMessage = 'Out of Memory: container killed by OOM limiter (128MB)';
        errorCategory = 'OOM';
      } else if (result.exitCode !== 0) {
        finalStatus = SubmissionStatus.FAILED;
        errorMessage = `Execution failed with exit code ${result.exitCode}`;
        const stderrStr = result.stderr || '';
        if (stderrStr.includes('SyntaxError') || stderrStr.includes('IndentationError')) {
          errorCategory = 'SYNTAX_ERROR';
        } else {
          errorCategory = 'RUNTIME_ERROR';
        }
      }

      // ── Atomic transactional result persistence ────────
      // BEGIN/COMMIT guarantees that the result INSERT and the status UPDATE
      // are either BOTH committed or BOTH rolled back. This closes the
      // split-brain crash window where a process kill between the two
      // statements would leave submissions.status permanently stuck at RUNNING
      // while submission_results already holds the output.
      //
      // The LREM acknowledgement is placed AFTER the COMMIT intentionally:
      // if the process crashes mid-transaction, Postgres rolls back automatically,
      // the job stays in the processing queue, and the System Monitor reaper
      // will recover and re-enqueue it safely.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1. Insert result — idempotent: skip silently if a prior attempt already wrote it
        await client.query(
          `INSERT INTO submission_results
             (job_id, exit_code, stdout, stderr, error_message, error_category, execution_time_ms, memory_used_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (job_id) DO NOTHING`,
          [job.jobId, result.exitCode, result.stdout, result.stderr, errorMessage, errorCategory, result.executionTimeMs, result.memoryUsedBytes]
        );

        // 2. Update parent submission status within the same atomic boundary
        await client.query(
          `UPDATE submissions SET status = $1, updated_at = NOW() WHERE id = $2`,
          [finalStatus, job.jobId]
        );

        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        logger.error({ jobId: job.jobId, txError }, 'Result transaction rolled back — job will be retried by reaper');
        throw txError; // Re-throw so the outer catch triggers requeueWithBackoff
      } finally {
        client.release();
      }

      // ── Acknowledge: remove from processing queue ───────
      // Only reached if the transaction above committed successfully.
      await redis.lrem(processingQueue, 1, rawJob);

      // ── Publish EXECUTION_COMPLETE system signal ────────
      const completeChunk = {
        type: 'system',
        data: 'EXECUTION_COMPLETE',
        timestamp: Date.now()
      };
      await redisPub.publish('jobs:streams:' + job.jobId, JSON.stringify(completeChunk));

      // ── Update Prometheus metrics ───────────────────────
      workerJobCounter.inc({ worker_id: workerId, status: finalStatus, language: job.language });
      executionDuration.observe({ language: job.language, status: finalStatus }, result.executionTimeMs);

      logger.info({ jobId: job.jobId, status: finalStatus, executionTimeMs: result.executionTimeMs }, 'Job completed');

    } catch (err) {
      logger.error({ err, jobId: job?.jobId }, 'Unhandled error in worker loop');

      // If we crashed mid-execution, attempt a retry with backoff
      if (job && rawJob) {
        try {
          await requeueWithBackoff(job, processingQueue, rawJob);
        } catch (requeueErr) {
          logger.error({ requeueErr, jobId: job.jobId }, 'Failed to requeue job after crash');
        }
      }
    }
  }

  clearInterval(heartbeatInterval);
  activeWorkers.dec();
  logger.info({ workerId }, 'Worker shut down gracefully');
}

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9101', 10);

async function bootstrap() {
  try {
    await startMetricsServer(METRICS_PORT, {
      queueDepthProvider: async () => {
        return await redis.llen(QUEUE_KEYS.PENDING);
      }
    });
    logger.info(`Prometheus Metrics server running on port ${METRICS_PORT}`);

    // Start processing — non-blocking, runs until SIGTERM
    processQueue();
  } catch (err) {
    logger.error(err, 'Worker bootstrap failed');
    process.exit(1);
  }
}

// Graceful shutdown: finish current job then exit
process.on('SIGTERM', () => {
  logger.info({ workerId }, 'SIGTERM received. Stopping after current job...');
  shouldRun = false;
});

process.on('SIGINT', () => {
  logger.info({ workerId }, 'SIGINT received. Stopping after current job...');
  shouldRun = false;
});

bootstrap();
