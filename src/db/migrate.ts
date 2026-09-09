import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Pool } from 'pg';

import { loadConfig } from '../config.js';
import { createPool } from './pool.js';

const migrations = ['001_initial.sql'] as const;

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [824_911_037]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const name of migrations) {
      const applied = await client.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name = $1) AS exists',
        [name],
      );
      if (applied.rows[0]?.exists) continue;

      const path = fileURLToPath(new URL(`./migrations/${name}`, import.meta.url));
      const sql = await readFile(path, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [824_911_037]).catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

