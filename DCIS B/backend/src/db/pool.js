import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error', { error: err.message });
});

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  logger.debug('SQL query', { text, duration: Date.now() - start, rows: res.rowCount });
  return res;
}

export async function getClient() {
  return pool.connect();
}
