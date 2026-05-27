import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { redis } from '../redis.js';
import { logger } from '@code-execution/logger';
import {
  SubmissionStatus, QueuePayload, DLQPayload,
  QUEUE_KEYS, MAX_CODE_LENGTH
} from '@code-execution/contracts';
import { queueDepth, activeWebSockets, websocketEvents } from '@code-execution/metrics';
import { activeStreams } from '../streams.js';

export async function submissionRoutes(fastify: FastifyInstance) {

  // POST /submissions
  fastify.post('/submissions', {
    schema: {
      body: {
        type: 'object',
        required: ['code', 'language'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: MAX_CODE_LENGTH },
          language: { type: 'string', enum: ['python', 'javascript'] },
          userId: { type: 'string', maxLength: 36 }
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
    logger.info({ jobId, language, userId, codeLength: code.length }, 'Received submission');

    await pool.query(
      'INSERT INTO submissions (id, user_id, language, source_code, status, retry_count, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [jobId, userId ?? null, language, code, SubmissionStatus.PENDING, 0, submittedAt, submittedAt]
    );

    const payload: QueuePayload = { jobId, userId, code, language, retryCount: 0, submittedAt };
    await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(payload));
    const depth = await redis.llen(QUEUE_KEYS.PENDING);
    queueDepth.set(depth);
    logger.info({ jobId }, 'Submission enqueued');
    return reply.status(201).send({ jobId, status: SubmissionStatus.PENDING });
  });

  // GET /submissions/:id
  fastify.get('/submissions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await pool.query(
      'SELECT s.id, s.user_id, s.language, s.source_code, s.status, s.retry_count, s.created_at, s.updated_at, r.exit_code, r.stdout, r.stderr, r.error_message, r.error_category, r.execution_time_ms, r.memory_used_bytes FROM submissions s LEFT JOIN submission_results r ON r.job_id = s.id WHERE s.id = $1',
      [id]
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Submission not found' });
    const row = result.rows[0];
    return reply.send({
      jobId: row.id, userId: row.user_id, language: row.language, sourceCode: row.source_code,
      status: row.status, retryCount: row.retry_count, exitCode: row.exit_code,
      stdout: row.stdout, stderr: row.stderr, errorMessage: row.error_message,
      errorCategory: row.error_category ?? null,
      executionTimeMs: row.execution_time_ms, memoryUsedBytes: row.memory_used_bytes ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at
    });
  });

  // GET /submissions — paginated list
  fastify.get('/submissions', async (request, reply) => {
    const { page = 1, limit = 10, status } = request.query as { page?: number; limit?: number; status?: string; };
    const validStatuses = Object.values(SubmissionStatus) as string[];
    if (status && !validStatuses.includes(status)) return reply.status(400).send({ error: 'Invalid status filter' });
    const offset = (page - 1) * limit;
    const queryParams: any[] = [];
    let statusFilter = '';
    if (status) { statusFilter = 'WHERE s.status = $1'; queryParams.push(status); }
    const countResult = await pool.query('SELECT COUNT(*) FROM submissions s ' + statusFilter, queryParams);
    const total = parseInt(countResult.rows[0].count, 10);
    const limitParamIndex = queryParams.length + 1;
    const offsetParamIndex = queryParams.length + 2;
    const result = await pool.query(
      'SELECT s.id, s.user_id, s.language, s.status, s.retry_count, s.created_at, s.updated_at FROM submissions s ' + statusFilter + ' ORDER BY s.created_at DESC LIMIT $' + limitParamIndex + ' OFFSET $' + offsetParamIndex,
      [...queryParams, limit, offset]
    );
    return reply.send({
      total, page, limit, totalPages: Math.ceil(total / limit),
      submissions: result.rows.map(row => ({ jobId: row.id, userId: row.user_id, language: row.language, status: row.status, retryCount: row.retry_count, createdAt: row.created_at, updatedAt: row.updated_at }))
    });
  });

  // GET /dlq — Dead Letter Queue inspection
  fastify.get('/dlq', async (request, reply) => {
    const { page = 1, limit = 20 } = request.query as { page?: number; limit?: number; };
    const start = (page - 1) * limit;
    const end = start + limit - 1;
    const [total, rawItems] = await Promise.all([
      redis.llen(QUEUE_KEYS.DEAD_LETTER),
      redis.lrange(QUEUE_KEYS.DEAD_LETTER, start, end)
    ]);
    const items = rawItems.map(raw => { try { return JSON.parse(raw) as DLQPayload; } catch { return { raw, parseError: true }; } });
    return reply.send({ total, page, limit, totalPages: Math.ceil(total / limit), items });
  });

  // DELETE /dlq/:jobId — remove specific job from DLQ
  fastify.delete('/dlq/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const allRaw = await redis.lrange(QUEUE_KEYS.DEAD_LETTER, 0, -1);
    let removed = 0;
    for (const raw of allRaw) {
      try {
        const item = JSON.parse(raw) as DLQPayload;
        if (item.jobId === jobId) { await redis.lrem(QUEUE_KEYS.DEAD_LETTER, 1, raw); removed++; break; }
      } catch { /* skip malformed */ }
    }
    if (removed === 0) return reply.status(404).send({ error: 'Job not found in DLQ' });
    logger.info({ jobId }, 'Job manually removed from DLQ');
    return reply.send({ success: true, jobId, message: 'Job removed from Dead Letter Queue' });
  });

  // GET /stream/:jobId — WebSocket real-time log stream
  fastify.get('/stream/:jobId', { websocket: true }, (connection, req) => {
    const { jobId } = req.params as { jobId: string };
    logger.info({ jobId }, 'Client connected to WebSocket stream');
    activeWebSockets.inc();
    websocketEvents.inc({ event: 'connect' });

    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      logger.info({ jobId }, 'WebSocket cleanup: removing socket from active streams');
      activeWebSockets.dec();
      websocketEvents.inc({ event: 'disconnect' });

      const sockets = activeStreams.get(jobId);
      if (sockets) {
        sockets.delete(connection.socket);
        if (sockets.size === 0) {
          activeStreams.delete(jobId);
        }
      }
    };

    let sockets = activeStreams.get(jobId);
    if (!sockets) {
      sockets = new Set();
      activeStreams.set(jobId, sockets);
    }
    sockets.add(connection.socket);

    connection.socket.on('close', cleanup);
    connection.socket.on('error', (err: any) => { logger.error(err, 'WebSocket error'); websocketEvents.inc({ event: 'error' }); });
  });

  // GET /health
  fastify.get('/health', async () => {
    return { status: 'OK', service: 'api-gateway', timestamp: new Date().toISOString() };
  });
}
