import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTestPool, resetDatabase, testDatabaseUrl } from './helpers/database.js';
import { runMigrations } from '../src/db/migrate.js';
import request from 'supertest';
import { createApp } from '../src/app.js';

it('lets a queued wallet create survive a five-second contention interval', async () => {
  const pool = await createTestPool();
  pool.options.max = 1;
  const holder = await pool.connect();
  let released = false;
  const release = () => { if (!released) { released = true; holder.release(); } };
  const timer = setTimeout(release, 5_300);
  try {
    const app = createApp({ pool, logLevel: 'silent' });
    const response = await request(app).post('/wallets')
      .set('authorization', `Bearer queue-${randomUUID()}`).send({ initial_balance_paise: 1 });
    expect(response.status).toBe(200);
    expect(response.body.balance_paise).toBe('1');
  } finally { clearTimeout(timer); release(); await pool.end(); }
}, 15_000);

it('returns a sanitized retryable 503 when pool acquisition expires', async () => {
  const pool = await createTestPool();
  pool.options.max = 1;
  pool.options.connectionTimeoutMillis = 50;
  const holder = await pool.connect();
  try {
    const response = await request(createApp({ pool, logLevel: 'silent' })).post('/wallets')
      .set('authorization', `Bearer timeout-${randomUUID()}`).send({});
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('database_busy');
    expect(JSON.stringify(response.body)).not.toContain('timeout exceeded');
  } finally { holder.release(); await pool.end(); }
});

it.each(['idle', 'active'])('survives an actual PostgreSQL %s connection termination', async mode => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'test/helpers/disconnect-probe.ts', mode], {
    env: { ...process.env, TEST_DATABASE_URL: testDatabaseUrl }, timeout: 15000,
  });
  expect(stdout).toContain('recovered');
});

it('serializes concurrent migrations and enforces final transfer outcomes at commit', async () => {
  const pool = await createTestPool();
  try {
    await Promise.all(Array.from({ length: 5 }, () => runMigrations(pool)));
    await resetDatabase(pool);
    const a = randomUUID(); const b = randomUUID();
    await pool.query("INSERT INTO wallets(id, user_id, balance_paise) VALUES ($1, 'a', 10), ($2, 'b', 0)", [a, b]);
    await expect(pool.query('UPDATE wallets SET balance_paise = -1 WHERE id = $1', [a])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO wallets(id, user_id, balance_paise) VALUES ($1, 'a', 0)", [randomUUID()])).rejects.toMatchObject({ code: '23505' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO transfers(id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status) VALUES ($1, 'pending-check', $2, $3, 1, 'pending')", [randomUUID(), a, b]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(0);
  } finally { await pool.end(); }
});

it('upgrades historical schema and keeps previously accepted keys and data', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: pg } = await import('pg');
  const admin = await createTestPool();
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
  try {
    await scoped.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of ['001_initial.sql', '002_defer_transfer_wallet_foreign_keys.sql']) {
      await scoped.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
      await scoped.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
    const a = randomUUID(); const b = randomUUID(); const transfer = randomUUID();
    await scoped.query("INSERT INTO wallets(id,user_id,balance_paise) VALUES ($1,'alice',99),($2,'bob',1)", [a,b]);
    await scoped.query("INSERT INTO transfers(id,idempotency_key,from_wallet_id,to_wallet_id,amount_paise,status) VALUES ($1,'legacy key ✓',$2,$3,1,'completed')", [transfer,a,b]);
    await runMigrations(scoped);
    expect((await scoped.query('SELECT id,idempotency_key,status FROM transfers')).rows).toEqual([{ id: transfer, idempotency_key: 'legacy key ✓', status: 'completed' }]);
    expect((await scoped.query('SELECT sum(balance_paise)::text AS total FROM wallets')).rows[0].total).toBe('100');
    expect((await scoped.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(3);
  } finally {
    await scoped.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
