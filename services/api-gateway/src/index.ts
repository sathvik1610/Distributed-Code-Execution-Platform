import 'dotenv/config';
import fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyRateLimit from '@fastify/rate-limit';
import { logger } from '@code-execution/logger';
import { startMetricsServer, rateLimitHits } from '@code-execution/metrics';
import { initDb } from './db.js';
import { submissionRoutes } from './routes/submissions.js';
import { redis } from './redis.js';
import { QUEUE_KEYS } from '@code-execution/contracts';
import { activeStreams } from './streams.js';

const app = fastify({
  logger: false // Use custom Pino logger instead
});

// Single global Redis subscriber connection duplicated from primary client
const subscriber = redis.duplicate();

subscriber.on('error', (err) => {
  logger.error(err, 'Redis global subscriber error');
});

subscriber.on('pmessage', (pattern, channel, message) => {
  const jobId = channel.replace('jobs:streams:', '');
  const sockets = activeStreams.get(jobId);
  if (sockets) {
    let isComplete = false;
    try {
      const chunk = JSON.parse(message);
      if (chunk.type === 'system' && chunk.data === 'EXECUTION_COMPLETE') {
        isComplete = true;
      }
    } catch { /* ignore non-JSON messages */ }

    for (const socket of sockets) {
      if (socket.readyState === 1) { // WebSocket.OPEN
        socket.send(message);
        if (isComplete) {
          logger.info({ jobId }, 'Execution complete — closing WebSocket');
          setTimeout(() => {
            if (socket.readyState === 1) {
              socket.close(1000, 'Execution complete');
            }
          }, 100);
        }
      }
    }
  }
});


// Auth Hook / Rate Limit Bypass Key
const API_KEY = process.env.API_KEY;

// Rate Limiting: 30 submissions per minute per IP.
// Counters live in Redis (not in-process memory) so limits are enforced
// correctly across multiple gateway instances behind a load balancer.
// @fastify/rate-limit uses atomic INCR + EXPIRE internally — no extra packages needed.
await app.register(fastifyRateLimit, {
  max: 30,
  timeWindow: '1 minute',
  redis: redis,
  keyGenerator: (request) => request.ip,
  allowList: (request: any) => {
    return request.url === '/health' ||
           request.ip === '127.0.0.1' ||
           request.ip === '::1' ||
           (API_KEY !== undefined && request.headers['x-api-key'] === API_KEY);
  },
  errorResponseBuilder: (_request, context) => {
    rateLimitHits.inc();
    return {
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Max ' + context.max + ' requests per ' + context.after + '.'
    };
  }
});

// Auth Hook: require X-API-Key on all /submissions and /dlq routes
if (!API_KEY) {
  logger.error('API_KEY environment variable not set! API Gateway auth is securely locked to FAIL-SECURE. All protected endpoints will reject requests.');
}

app.addHook('onRequest', async (request, reply) => {
  const url = request.url;
  if (url === '/health' || url.startsWith('/stream/')) return;
  if (!API_KEY) {
    logger.error({ ip: request.ip, url }, 'Blocked request to protected route because API_KEY is not configured on the server.');
    return reply.status(500).send({ error: 'Internal Server Error', message: 'API Gateway is securely locked. API_KEY environment variable is not configured on the server.' });
  }
  const provided = request.headers['x-api-key'];
  if (provided !== API_KEY) {
    logger.warn({ ip: request.ip, url }, 'Unauthorized request — invalid or missing X-API-Key');
    return reply.status(401).send({ error: 'Unauthorized', message: 'Valid X-API-Key header required.' });
  }
});

app.register(fastifyWebsocket);
app.register(submissionRoutes);

const PORT = parseInt(process.env.PORT || '8000', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9100', 10);

async function bootstrap() {
  try {
    await initDb();
    await startMetricsServer(METRICS_PORT, {
      queueDepthProvider: async () => {
        return await redis.llen(QUEUE_KEYS.PENDING);
      }
    });
    logger.info('Prometheus Metrics server running on port ' + METRICS_PORT);
    
    // Subscribe to all stream key events globally
    await subscriber.psubscribe('jobs:streams:*');
    logger.info('Global Redis subscriber psubscribe active');

    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info('API Gateway running on port ' + PORT);
  } catch (err) {
    logger.error(err, 'Bootstrap failed');
    process.exit(1);
  }
}

bootstrap();
