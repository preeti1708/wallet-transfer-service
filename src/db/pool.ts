import pg from 'pg';
import { createLogger } from '../observability/logger.js';

const { Pool } = pg;

export function createPool(databaseUrl: string, maxConnections = 20): pg.Pool {
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 40) {
    throw new Error('Database pool size must be an integer from 1 to 40');
  }
  const logger = createLogger('warn');
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'wallet-transfer-service',
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    // This also bounds the pool's acquisition queue. Free-tier contention can
    // take longer than five seconds even when each transaction is healthy.
    connectionTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    lock_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  // pg emits socket errors separately from query promise rejections. Keep an
  // error listener on checked-out clients as well as on the idle pool.
  pool.on('connect', client => {
    client.on('error', error => logger.error({ event: 'database.connection_error', err: error }, 'Database connection failed'));
  });
  pool.on('error', error => logger.error({ event: 'database.pool_error', err: error }, 'Idle database connection failed'));
  return pool;
}
