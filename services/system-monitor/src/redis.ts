import { Redis } from 'ioredis';
import { logger } from '@code-execution/logger';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Main connection for queue operations and heartbeat scanning
export const redis = new Redis(redisUrl);

redis.on('error', (err: Error) => logger.error(err, 'Redis connection error in system-monitor'));
redis.on('connect', () => logger.info('System Monitor connected to Redis'));
