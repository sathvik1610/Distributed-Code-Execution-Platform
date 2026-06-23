import pg from 'pg';
import { logger } from '@code-execution/logger';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/code_execution'
});

pool.on('error', (err) => {
  logger.error(err, 'PostgreSQL connection error');
});

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE submission_results
        ADD COLUMN IF NOT EXISTS output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS stream_output_limit_exceeded BOOLEAN NOT NULL DEFAULT FALSE
    `);
    logger.info('Connected to PostgreSQL successfully and verified result schema');
  } finally {
    client.release();
  }
}