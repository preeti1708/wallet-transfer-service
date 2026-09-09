import type { Pool } from 'pg';

import { runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/wallet_transfer_test';

export async function createTestPool(): Promise<Pool> {
  const pool = createPool(testDatabaseUrl);
  await runMigrations(pool);
  return pool;
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE transfers, wallets RESTART IDENTITY CASCADE');
}
