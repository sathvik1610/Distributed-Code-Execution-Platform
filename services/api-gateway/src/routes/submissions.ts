import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { Redis } from 'ioredis';
import { pool } from '../db.js';
import { redis } from '../redis.js';
import { logger } from '@code-execution/logger';
import { SubmissionStatus, QueuePayload, QUEUE_KEYS } from '@code-execution/contracts';
import { queueDepth, activeWebSockets, websocketEvents } from '@code-execution/metrics';

export async function submissionRoutes(fastify: FastifyInstance) {
  // ──────────────────────────────────────────────────────────
  // POST /submissions
  // Accepts code + language, stores in DB, enqueues in Redis.
  // ──────────────────────────────────────────────────────────
  fastify.post('/submissions', {
    schema: {
      body: {
        type: 'object',
        required: ['code', 'language'],
        properties: {
          code: { type: 'string', minLength: 1 },
          language: { type: 'string', enum: ['python', 'javascript'] },
          userId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { code, language, userId } = request.body as {
      code: string;
      language: 'python' | 'javascript';
      userId?: string;
    };

    const jobId = uuidv4();
    const submittedAt = new Date().toISOString();

    logger.info({ jobId, language, userId }, 'Received code submission request');

    // 1. Write initial PENDING state to database
    await pool.query(
      `INSERT INTO submissions (id, user_id, language, source_code, status, retry_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [jobId, userId ?? null, language, code, SubmissionStatus.PENDING, 0, submittedAt, submittedAt]
    );

    // 2. Build queue payload
    const payload: QueuePayload = {
      jobId,
      userId,
      code,
      language,
      retryCount: 0,
      submittedAt
    };

    // 3. Enqueue atomically in Redis
    await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(payload));

    // 4. Update queue depth metric
    const depth = await redis.llen(QUEUE_KEYS.PENDING);
    queueDepth.set(depth);

    logger.info({ jobId }, 'Submission enqueued successfully');

    return reply.status(201).send({
      jobId,
      status: SubmissionStatus.PENDING
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /submissions/:id
  // Returns full submission + result detail.
  // ──────────────────────────────────────────────────────────
  fastify.get('/submissions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Join submissions and submission_results for a full response
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.language, s.source_code, s.status, s.retry_count,
              s.created_at, s.updated_at,
              r.exit_code, r.stdout, r.stderr, r.error_message,
              r.execution_time_ms, r.memory_used_bytes
       FROM submissions s
       LEFT JOIN submission_results r ON r.job_id = s.id
       WHERE s.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Submission not found' });
    }

    const row = result.rows[0];
    return reply.send({
      jobId: row.id,
      userId: row.user_id,
      language: row.language,
      sourceCode: row.source_code,
      status: row.status,
      retryCount: row.retry_count,
      exitCode: row.exit_code,
      stdout: row.stdout,
      stderr: row.stderr,
      errorMessage: row.error_message,
      executionTimeMs: row.execution_time_ms,
      memoryUsedBytes: row.memory_used_bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /submissions
  // Paginated list of all submissions. Supports ?page, ?limit, ?status
  // ──────────────────────────────────────────────────────────
  fastify.get('/submissions', async (request, reply) => {
    const { page = 1, limit = 10, status } = request.query as {
      page?: number;
      limit?: number;
      status?: string;
    };

    const validStatuses = Object.values(SubmissionStatus) as string[];
    if (status && !validStatuses.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status filter' });
    }

    const offset = (page - 1) * limit;

    const queryParams: any[] = [];
    let statusFilter = '';
    if (status) {
      statusFilter = 'WHERE s.status = $1';
      queryParams.push(status);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM submissions s ${statusFilter}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const limitParamIndex = queryParams.length + 1;
    const offsetParamIndex = queryParams.length + 2;
    const resultQueryParams = [...queryParams, limit, offset];

    const result = await pool.query(
      `SELECT s.id, s.user_id, s.language, s.source_code, s.status, s.retry_count,
              s.created_at, s.updated_at
       FROM submissions s
       ${statusFilter}
       ORDER BY s.created_at DESC
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      resultQueryParams
    );

    const submissions = result.rows.map(row => ({
      jobId: row.id,
      userId: row.user_id,
      language: row.language,
      status: row.status,
      retryCount: row.retry_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    return reply.send({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      submissions
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /stream/:jobId  (WebSocket)
  // Subscribes to Redis pub/sub and streams stdout/stderr to client.
  // CRITICAL: Unsubscribes on close to prevent Redis connection leak.
  // ──────────────────────────────────────────────────────────
  fastify.get('/stream/:jobId', { websocket: true }, (connection, req) => {
    const { jobId } = req.params as { jobId: string };

    logger.info({ jobId }, 'Client connected to WebSocket stream');
    activeWebSockets.inc();
    websocketEvents.inc({ event: 'connect' });

    // Each WebSocket gets its own dedicated Redis subscriber connection
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const subscriber = new Redis(redisUrl);

    const channel = QUEUE_KEYS.STREAM(jobId);

    subscriber.subscribe(channel, (err: any) => {
      if (err) {
        logger.error(err, `Failed to subscribe to Redis channel ${channel}`);
        connection.socket.close(1011, 'Redis subscription failed');
        return;
      }
      logger.info({ jobId, channel }, 'Successfully subscribed to Redis channel');
    });

    subscriber.on('message', (chan, message) => {
      if (chan === channel && connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.send(message);
      }
    });

    subscriber.on('error', (err: Error) => {
      logger.error(err, 'Redis subscriber error');
    });

    // IMPORTANT: Clean up the Redis subscriber on disconnect to prevent memory leaks
    connection.socket.on('close', () => {
      logger.info({ jobId }, 'WebSocket closed — cleaning up Redis subscriber...');
      activeWebSockets.dec();
      websocketEvents.inc({ event: 'disconnect' });

      subscriber.unsubscribe(channel)
        .then(() => subscriber.quit())
        .catch((err: Error) => {
          logger.error(err, 'Error cleanly closing Redis subscriber');
          subscriber.disconnect();
        });
    });

    connection.socket.on('error', (err: any) => {
      logger.error(err, 'WebSocket socket error');
      websocketEvents.inc({ event: 'error' });
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /health
  // Lightweight liveness check used by load balancers.
  // ──────────────────────────────────────────────────────────
  fastify.get('/health', async () => {
    return { status: 'OK', service: 'api-gateway', timestamp: new Date().toISOString() };
  });
}
