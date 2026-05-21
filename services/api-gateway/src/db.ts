import pg from 'pg';
import { logger } from '@code-execution/logger';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/code_execution'
});

pool.on('error', (err) => {
  logger.error(err, 'Unexpected error on idle PostgreSQL client');
});

export async function initDb() {
  const client = await pool.connect();
  try {
    logger.info('Connected to PostgreSQL successfully');
  } finally {
    client.release();
  }
}
