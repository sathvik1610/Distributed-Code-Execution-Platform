import { Redis } from 'ioredis';
import { logger } from '@code-execution/logger';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Main connection for commands and queue operations
export const redis = new Redis(redisUrl);

// Separate connection for pub/sub stream publishing
export const redisPub = new Redis(redisUrl);

redis.on('error', (err: Error) => logger.error(err, 'Redis connection error'));
redisPub.on('error', (err: Error) => logger.error(err, 'Redis Pub connection error'));
