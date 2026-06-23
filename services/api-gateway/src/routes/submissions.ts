import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { redis } from '../redis.js';
import { logger } from '@code-execution/logger';
import {
  SubmissionStatus, QueuePayload, DLQPayload, StreamChunk,
  QUEUE_KEYS, MAX_CODE_LENGTH, isTerminalStatus
} from '@code-execution/contracts';
import {
  queueDepth, activeWebSockets, websocketEvents,
  enqueueFailures, websocketReplayConnections
} from '@code-execution/metrics';
import { activeStreams } from '../streams.js';

function parsePositiveInteger(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

function parseStreamPayload(entry: unknown): string | null {
  if (!Array.isArray(entry) || !Array.isArray(entry[1])) return null;
  const fields = entry[1] as string[];
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === 'payload') return fields[i + 1] ?? null;
  }
  return null;
}

function isCompletionPayload(payload: string): boolean {
  try {
    const chunk = JSON.parse(payload) as StreamChunk;
    return chunk.type === 'system' && chunk.data === 'EXECUTION_COMPLETE';
  } catch {
    return false;
  }
}

export async function submissionRoutes(fastify: FastifyInstance) {

  fastify.post('/submissions', {
    schema: {
      body: {
        type: 'object',
        required: ['code', 'language'],
        additionalProperties: false,
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
    try {
      await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(payload));
      const depth = await redis.llen(QUEUE_KEYS.PENDING);
      queueDepth.set(depth);
    } catch (err) {
      enqueueFailures.inc();
      logger.error({ err, jobId }, 'Failed to enqueue submission after DB insert');
      await pool.query(
        `UPDATE submissions SET status = $1, updated_at = NOW() WHERE id = $2`,
        [SubmissionStatus.FAILED, jobId]
      );
      await pool.query(
        `INSERT INTO submission_results (job_id, exit_code, stdout, stderr, error_message, error_category, output_truncated, stream_output_limit_exceeded)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_id) DO UPDATE SET
           error_message = EXCLUDED.error_message,
           error_category = EXCLUDED.error_category`,
        [jobId, null, '', '', 'Infrastructure error: failed to enqueue submission', 'UNKNOWN', false, false]
      );
      return reply.status(503).send({ jobId, status: SubmissionStatus.FAILED, error: 'Failed to enqueue submission' });
    }

    logger.info({ jobId }, 'Submission enqueued');
    return reply.status(201).send({ jobId, status: SubmissionStatus.PENDING });
  });

  fastify.get('/submissions/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1, maxLength: 64 } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await pool.query(
      'SELECT s.id, s.user_id, s.language, s.source_code, s.status, s.retry_count, s.created_at, s.updated_at, r.exit_code, r.stdout, r.stderr, r.error_message, r.error_category, r.execution_time_ms, r.memory_used_bytes, r.output_truncated, r.stream_output_limit_exceeded FROM submissions s LEFT JOIN submission_results r ON r.job_id = s.id WHERE s.id = $1',
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
      outputTruncated: row.output_truncated ?? false,
      streamOutputLimitExceeded: row.stream_output_limit_exceeded ?? false,
      createdAt: row.created_at, updatedAt: row.updated_at
    });
  });

  fastify.get('/submissions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string', enum: Object.values(SubmissionStatus) }
        }
      }
    }
  }, async (request, reply) => {
    const query = request.query as { page?: number; limit?: number; status?: string; };
    const safePage = parsePositiveInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
    const safeLimit = parsePositiveInteger(query.limit, 10, 100);
    if (safePage === null || safeLimit === null) return reply.status(400).send({ error: 'Invalid pagination parameters' });

    const queryParams: any[] = [];
    let statusFilter = '';
    if (query.status) {
      statusFilter = 'WHERE s.status = $1';
      queryParams.push(query.status);
    }
    const offset = (safePage - 1) * safeLimit;
    const countResult = await pool.query('SELECT COUNT(*) FROM submissions s ' + statusFilter, queryParams);
    const total = parseInt(countResult.rows[0].count, 10);
    const limitParamIndex = queryParams.length + 1;
    const offsetParamIndex = queryParams.length + 2;
    const result = await pool.query(
      'SELECT s.id, s.user_id, s.language, s.status, s.retry_count, s.created_at, s.updated_at FROM submissions s ' + statusFilter + ' ORDER BY s.created_at DESC LIMIT $' + limitParamIndex + ' OFFSET $' + offsetParamIndex,
      [...queryParams, safeLimit, offset]
    );
    return reply.send({
      total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit),
      submissions: result.rows.map(row => ({ jobId: row.id, userId: row.user_id, language: row.language, status: row.status, retryCount: row.retry_count, createdAt: row.created_at, updatedAt: row.updated_at }))
    });
  });

  fastify.get('/dlq', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 }
        }
      }
    }
  }, async (request, reply) => {
    const query = request.query as { page?: number; limit?: number; };
    const page = parsePositiveInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInteger(query.limit, 20, 100);
    if (page === null || limit === null) return reply.status(400).send({ error: 'Invalid pagination parameters' });

    const start = (page - 1) * limit;
    const end = start + limit - 1;
    const [total, rawItems] = await Promise.all([
      redis.llen(QUEUE_KEYS.DEAD_LETTER),
      redis.lrange(QUEUE_KEYS.DEAD_LETTER, start, end)
    ]);
    const items = rawItems.map(raw => { try { return JSON.parse(raw) as DLQPayload; } catch { return { raw, parseError: true }; } });
    return reply.send({ total, page, limit, totalPages: Math.ceil(total / limit), items });
  });

  fastify.delete('/dlq/:jobId', {
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string', minLength: 1, maxLength: 64 } }
      }
    }
  }, async (request, reply) => {
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

  fastify.get('/stream/:jobId', {
    websocket: true,
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string', minLength: 1, maxLength: 64 } }
      }
    }
  }, (connection, req) => {
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
        if (sockets.size === 0) activeStreams.delete(jobId);
      }
    };

    connection.socket.on('close', cleanup);
    connection.socket.on('error', (err: any) => { logger.error(err, 'WebSocket error'); websocketEvents.inc({ event: 'error' }); });

    let sockets = activeStreams.get(jobId);
    if (!sockets) {
      sockets = new Set();
      activeStreams.set(jobId, sockets);
    }
    sockets.add(connection.socket);

    void (async () => {
      const dbResult = await pool.query('SELECT status FROM submissions WHERE id = $1', [jobId]);
      if (dbResult.rows.length === 0) {
        connection.socket.close(1008, 'Submission not found');
        return;
      }

      const streamKey = QUEUE_KEYS.STREAM(jobId);
      const entries = await redis.xrange(streamKey, '-', '+') as unknown[];
      let replayed = false;
      let sawCompletion = false;

      for (const entry of entries) {
        const payload = parseStreamPayload(entry);
        if (!payload) continue;
        replayed = true;
        if (connection.socket.readyState === 1) connection.socket.send(payload);
        if (isCompletionPayload(payload)) sawCompletion = true;
      }

      if (replayed) websocketReplayConnections.inc();

      const status = dbResult.rows[0].status as SubmissionStatus;
      if (sawCompletion || isTerminalStatus(status)) {
        setTimeout(() => {
          if (connection.socket.readyState === 1) connection.socket.close(1000, 'Execution complete');
        }, 100);
      }
    })().catch((err) => {
      logger.error({ err, jobId }, 'Failed to prepare WebSocket stream replay');
      if (connection.socket.readyState === 1) connection.socket.close(1011, 'Stream replay failed');
    });
  });

  fastify.get('/health', async () => {
    return { status: 'OK', service: 'api-gateway', timestamp: new Date().toISOString() };
  });
}