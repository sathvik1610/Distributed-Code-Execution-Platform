import { Redis } from 'ioredis';
import { logger } from '@code-execution/logger';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl);

redis.on('connect', () => {
  logger.info('Connected to Redis successfully');
});

redis.on('error', (err: Error) => {
  logger.error(err, 'Redis connection error');
});
