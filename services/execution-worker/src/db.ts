import pg from 'pg';
import { logger } from '@code-execution/logger';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/code_execution'
});

pool.on('error', (err) => {
  logger.error(err, 'PostgreSQL connection error');
});
