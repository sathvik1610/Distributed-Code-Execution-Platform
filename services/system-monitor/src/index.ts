import 'dotenv/config';
import { logger } from '@code-execution/logger';
import { startMetricsServer } from '@code-execution/metrics';
import { runReaperScan } from './reaper.js';
import { redis } from './redis.js';
import { QUEUE_KEYS } from '@code-execution/contracts';

// ── Configuration ──────────────────────────────────────────────────────────

// How often the reaper scans for dead workers (milliseconds)
const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '10000', 10); // default: 10s

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9102', 10);

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap() {
  try {
    logger.info('Starting System Monitor / Reaper service...');

    // Start Prometheus metrics server
    await startMetricsServer(METRICS_PORT, {
      queueDepthProvider: async () => {
        return await redis.llen(QUEUE_KEYS.PENDING);
      }
    });
    logger.info(`Prometheus Metrics server running on port ${METRICS_PORT}`);

    // Run an immediate scan on startup to recover jobs from any crash during downtime
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
