import 'dotenv/config';
import { logger } from '@code-execution/logger';
import { startMetricsServer } from '@code-execution/metrics';
import { runReaperScan } from './reaper.js';
import { redis } from './redis.js';
import { pool, initDb } from './db.js';
import { QUEUE_KEYS, QueuePayload, SubmissionStatus } from '@code-execution/contracts';

// ── Configuration ──────────────────────────────────────────────────────────

// How often the reaper scans for dead workers (milliseconds)
const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '10000', 10); // default: 10s

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9102', 10);

// ── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * Recovers queue state after a Redis restart or monitor downtime.
 *
 * Problem: Redis Lists are in-memory. If Redis restarts (even with AOF disabled
 * or before a flush), jobs:queue:pending can be empty while PostgreSQL still
 * has rows in PENDING or RUNNING state with no worker claiming them — stuck forever.
 *
 * Fix:
 * 1. Reset all RUNNING jobs to PENDING. Any RUNNING without an active worker is
 *    permanently stuck — no worker will ever finish it, so we safely reset it.
 *    (If a worker IS alive, it holds the job in its processing queue and its
 *    heartbeat is present — the reaper scan handles that path separately.)
 * 2. If the Redis pending queue is empty but the DB has PENDING jobs, re-hydrate
 *    the queue from the DB. This covers the Redis-restart-data-loss scenario.
 */
async function recoverOrphanedJobsOnStartup(): Promise<void> {
  logger.info('Running startup queue recovery check...');

  // Step 1: Reset stuck RUNNING jobs to PENDING
  const resetResult = await pool.query<{ id: string; language: string; source_code: string; user_id: string; retry_count: number; created_at: Date }>(
    `UPDATE submissions
     SET status = $1, updated_at = NOW()
     WHERE status = $2
     RETURNING id, language, source_code, user_id, retry_count, created_at`,
    [SubmissionStatus.PENDING, SubmissionStatus.RUNNING]
  );

  if (resetResult.rows.length > 0) {
    logger.warn(
      { count: resetResult.rows.length },
      'Startup recovery: reset RUNNING jobs to PENDING (no active worker found)'
    );
  }

  // Step 2: Re-hydrate Redis queue if it is empty but DB has PENDING jobs
  const pendingQueueLen = await redis.llen(QUEUE_KEYS.PENDING);

  if (pendingQueueLen === 0) {
    const pendingInDb = await pool.query<{ id: string; language: string; source_code: string; user_id: string; retry_count: number; created_at: Date }>(
      `SELECT id, language, source_code, user_id, retry_count, created_at
       FROM submissions
       WHERE status = $1
       ORDER BY created_at ASC`,
      [SubmissionStatus.PENDING]
    );

    if (pendingInDb.rows.length > 0) {
      logger.warn(
        { count: pendingInDb.rows.length },
        'Startup recovery: Redis queue empty but DB has PENDING jobs — re-hydrating queue'
      );

      for (const row of pendingInDb.rows) {
        const payload: QueuePayload = {
          jobId: row.id,
          userId: row.user_id,
          code: row.source_code,
          language: row.language as 'python' | 'javascript',
          retryCount: row.retry_count,
          submittedAt: row.created_at.toISOString()
        };
        await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(payload));
      }

      logger.info({ count: pendingInDb.rows.length }, 'Startup recovery: queue re-hydrated from DB');
    }
  } else {
    logger.info({ pendingQueueLen }, 'Startup recovery: Redis queue has jobs, no re-hydration needed');
  }
}

async function bootstrap() {
  try {
    logger.info('Starting System Monitor / Reaper service...');
    await initDb();

    // Start Prometheus metrics server
    await startMetricsServer(METRICS_PORT, {
      queueDepthProvider: async () => {
        return await redis.llen(QUEUE_KEYS.PENDING);
      }
    });
    logger.info(`Prometheus Metrics server running on port ${METRICS_PORT}`);

    // Recover any jobs orphaned by Redis restart or monitor downtime
    await recoverOrphanedJobsOnStartup();

    // Run an immediate scan to recover jobs from any worker crash during downtime
    logger.info('Running initial startup reaper scan...');
    await runReaperScan();

    // Schedule recurring scans
    const reaperInterval = setInterval(async () => {
      await runReaperScan();
    }, REAPER_INTERVAL_MS);

    logger.info(
      { intervalMs: REAPER_INTERVAL_MS },
      `System Monitor running. Reaper scanning every ${REAPER_INTERVAL_MS / 1000}s`
    );

    // Graceful shutdown
    const shutdown = (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received. Stopping System Monitor...');
      clearInterval(reaperInterval);
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    logger.error(err, 'System Monitor bootstrap failed');
    process.exit(1);
  }
}

bootstrap();
