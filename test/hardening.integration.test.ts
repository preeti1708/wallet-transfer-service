import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import pg from 'pg';

import { createApp } from '../src/app.js';
import { createTestPool, resetDatabase, testDatabaseUrl } from './helpers/database.js';

// These cases catch canonicalization errors, partial commits, pool starvation,
// precision loss and treating a previous decline as a new payment.
describe('transaction and API regression checks', () => {
  let pool: Pool;
  let app: Express;
  beforeAll(async () => { pool = await createTestPool(); app = createApp({ pool, logLevel: 'silent' }); });
  beforeEach(async () => { await resetDatabase(pool); });
  afterAll(async () => { await pool.end(); });

  async function wallet(user: string, balance = 100): Promise<string> {
    const response = await request(app).post('/wallets').auth(user, { type: 'bearer' }).send({ initial_balance_paise: balance });
    expect(response.status).toBe(200);
    return response.body.id as string;
  }
  const send = (body: object, user = 'alice', target = app) => request(target).post('/transfers').auth(user, { type: 'bearer' }).send(body);
  const command = (from: string, to: string, amount = 10) => ({ from, to, amount_paise: amount, idempotency_key: randomUUID() });
  async function balances() {
    return (await pool.query('SELECT id, balance_paise::text FROM wallets ORDER BY id')).rows;
  }

  it('canonicalizes uppercase UUIDs before authorization, distinctness and replay matching', async () => {
    const from = await wallet('alice'); const to = await wallet('bob');
    const body = command(from.toUpperCase(), to.toUpperCase());
    const first = await send(body);
    expect(first.status).toBe(200);
    const replay = await send({ ...body, from, to });
    expect(replay.body).toEqual(first.body);
    expect((await send({ ...command(from, from.toUpperCase()) })).status).toBe(400);
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '10', null])('rejects invalid amount %s without storing a key', async (amount) => {
    const from = await wallet('alice'); const to = await wallet('bob');
    expect((await send({ ...command(from, to), amount_paise: amount })).status).toBe(400);
    expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(0);
  });

  it('validates IDs, bounded PostgreSQL-compatible keys, missing wallets and participant access', async () => {
    const from = await wallet('alice'); const to = await wallet('bob');
    for (const body of [command('invalid', to), { ...command(from, to), idempotency_key: '' }, { ...command(from, to), idempotency_key: '\u0000' }, { ...command(from, to), idempotency_key: 'x'.repeat(129) }]) {
      expect((await send(body)).status).toBe(400);
    }
    for (const body of [command(from, randomUUID()), command(randomUUID(), to)]) expect((await send(body)).status).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(0);
    const response = await send(command(from, to));
    for (const user of ['alice', 'bob']) expect((await request(app).get(`/transfers/${response.body.id}`).auth(user, { type: 'bearer' })).body).toEqual(response.body);
    expect((await request(app).get(`/transfers/${response.body.id}`).auth('outsider', { type: 'bearer' })).status).toBe(404);
    expect((await request(app).get(`/transfers/${randomUUID()}`).auth('alice', { type: 'bearer' })).status).toBe(404);
    expect((await request(app).get('/wallets/not-a-uuid').auth('alice', { type: 'bearer' })).status).toBe(400);
  });

  it('preserves replay for previously valid Unicode and whitespace keys', async () => {
    const from = await wallet('alice'); const to = await wallet('bob');
    for (const key of ['invoice 1', 'नमस्ते', ' ']) {
      const body = { ...command(from, to), idempotency_key: key };
      const first = await send(body);
      expect(first.status).toBe(200);
      expect((await send(body)).body).toEqual(first.body);
    }
  });

  it('replays the original decline after replenishment and from a fresh application instance', async () => {
    const from = await wallet('alice', 10); const to = await wallet('bob', 100);
    const body = command(from, to, 11);
    const first = await send(body);
    expect(first.body).toMatchObject({ status: 'declined', decline_reason: 'insufficient_funds' });
    expect((await send(command(to, from, 50), 'bob')).body.status).toBe('completed');
    const restartedApp = createApp({ pool, logLevel: 'silent' });
    expect((await send(body, 'alice', restartedApp)).body).toEqual(first.body);
    expect((await request(app).get(`/wallets/${from}`).auth('alice', { type: 'bearer' })).body.balance_paise).toBe('60');
    const replayedCreation = await request(app).post('/wallets').auth('alice', { type: 'bearer' }).send({ initial_balance_paise: 99999 });
    expect(replayedCreation.body.balance_paise).toBe('60');
  });

  it('recovers 30 duplicate requests with a one-connection pool', async () => {
    const from = await wallet('alice'); const to = await wallet('bob', 0);
    const smallPool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1, connectionTimeoutMillis: 2000 });
    try {
      const smallApp = createApp({ pool: smallPool, logLevel: 'silent' });
      const body = command(from, to);
      const responses = await Promise.all(Array.from({ length: 30 }, () => send(body, 'alice', smallApp)));
      expect(responses.every(r => r.status === 200)).toBe(true);
      expect(new Set(responses.map(r => r.text)).size).toBe(1);
      expect((await smallPool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(1);
      expect(smallPool.idleCount).toBe(1);
    } finally { await smallPool.end(); }
  });

  it('preserves exact BIGINT balances beyond JavaScript safe integers', async () => {
    const from = await wallet('alice'); const to = await wallet('bob', 0);
    await pool.query('UPDATE wallets SET balance_paise = $1 WHERE id = $2', ['9007199254740993', from]);
    expect((await send(command(from, to, 2))).body.status).toBe('completed');
    expect((await request(app).get(`/wallets/${from}`).auth('alice', { type: 'bearer' })).body.balance_paise).toBe('9007199254740991');
    expect((await request(app).get(`/wallets/${to}`).auth('bob', { type: 'bearer' })).body.balance_paise).toBe('2');
  });

  it('durably declines recipient BIGINT overflow without a partial debit', async () => {
    const from = await wallet('alice'); const to = await wallet('bob', 0);
    await pool.query('UPDATE wallets SET balance_paise = $1 WHERE id = $2', ['9223372036854775807', to]);
    const before = await balances(); const body = command(from, to, 1);
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'declined', decline_reason: 'destination_balance_limit' });
    expect((await send(body)).body).toEqual(response.body);
    expect(await balances()).toEqual(before);
  });

  it.each(['credit', 'commit'])('rolls back debit, credit and key after a forced %s failure, then allows retry', async (stage) => {
    const from = await wallet('alice'); const to = await wallet('bob', 0);
    const before = await balances(); const body = command(from, to);
    // Real PostgreSQL failure injection, kept entirely in this disposable test DB.
    await pool.query(`CREATE FUNCTION test_fail_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test forced database failure'; END $$`);
    if (stage === 'credit') {
      await pool.query(`CREATE TRIGGER test_failure BEFORE UPDATE ON wallets FOR EACH ROW WHEN (NEW.balance_paise > OLD.balance_paise) EXECUTE FUNCTION test_fail_transfer()`);
    } else {
      await pool.query(`CREATE CONSTRAINT TRIGGER test_failure AFTER INSERT ON transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_transfer()`);
    }
    try {
      const response = await send(body);
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('internal_error');
      expect(await balances()).toEqual(before);
      expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(0);
    } finally {
      await pool.query(`DROP TRIGGER test_failure ON ${stage === 'credit' ? 'wallets' : 'transfers'}`);
      await pool.query('DROP FUNCTION test_fail_transfer()');
    }
    expect((await send(body)).body.status).toBe('completed');
    expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(1);
  });

  it('lets affordable debits compete for a balance insufficient for their aggregate', async () => {
    const from = await wallet('alice', 25); const to = await wallet('bob', 0);
    const bodies = Array.from({ length: 50 }, () => command(from, to, 3));
    const responses = await Promise.all(bodies.map(b => send(b)));
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(responses.filter(r => r.body.status === 'completed')).toHaveLength(8);
    expect(responses.filter(r => r.body.decline_reason === 'insufficient_funds')).toHaveLength(42);
    expect((await request(app).get(`/wallets/${from}`).auth('alice', { type: 'bearer' })).body.balance_paise).toBe('1');
    expect((await request(app).get(`/wallets/${to}`).auth('bob', { type: 'bearer' })).body.balance_paise).toBe('24');
    expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(50);
    const replays = await Promise.all(bodies.map(b => send(b)));
    expect(replays.map(r => r.text)).toEqual(responses.map(r => r.text));
  });

  it('never misclassifies a different unique constraint failure as an idempotent replay', async () => {
    const from = await wallet('alice'); const to = await wallet('bob');
    await pool.query('CREATE UNIQUE INDEX test_unique_amount ON transfers(amount_paise)');
    try {
      expect((await send(command(from, to))).status).toBe(200);
      expect((await send(command(from, to))).status).toBe(500);
      expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(1);
    } finally { await pool.query('DROP INDEX test_unique_amount'); }
  });
});
