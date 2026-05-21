import 'dotenv/config';
import fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logger } from '@code-execution/logger';
import { startMetricsServer } from '@code-execution/metrics';
import { initDb } from './db.js';
import { submissionRoutes } from './routes/submissions.js';
import { redis } from './redis.js';
import { QUEUE_KEYS } from '@code-execution/contracts';

const app = fastify({
  logger: false // Use custom Pino logger instead
});

// Register WebSocket support
app.register(fastifyWebsocket);

// Register routes
app.register(submissionRoutes);

const PORT = parseInt(process.env.PORT || '8000', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9100', 10);

async function bootstrap() {
  try {
    // 1. Initialize databases
    await initDb();

    // 2. Start Metrics Server
    await startMetricsServer(METRICS_PORT, {
      queueDepthProvider: async () => {
        return await redis.llen(QUEUE_KEYS.PENDING);
      }
    });
    logger.info(`Prometheus Metrics server running on port ${METRICS_PORT}`);

    // 3. Start API Gateway
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`API Gateway running on port ${PORT}`);
  } catch (err) {
    logger.error(err, 'Bootstrap failed');
    process.exit(1);
  }
}

bootstrap();
