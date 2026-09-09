import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';

import { createApp } from '../src/app.js';
import { createTestPool, resetDatabase } from './helpers/database.js';

async function createWallet(app: Express, user: string, balance: number): Promise<string> {
  const response = await request(app)
    .post('/wallets')
    .set('authorization', `Bearer ${user}`)
    .send({ initial_balance_paise: balance });
  expect(response.status).toBe(200);
  return response.body.id as string;
}

describe('transfer API', () => {
  let pool: Pool;
  let app: Express;

  beforeAll(async () => {
    pool = await createTestPool();
    app = createApp({ pool, logLevel: 'silent' });
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('moves integer paise atomically and exposes the stored transfer', async () => {
    const from = await createWallet(app, 'alice', 10_000);
    const to = await createWallet(app, 'bob', 500);

    const response = await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer alice')
      .send({ from, to, amount_paise: 1_250, idempotency_key: 'payment-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      from,
      to,
      amount_paise: '1250',
      status: 'completed',
      decline_reason: null,
    });
    expect((await request(app).get(`/wallets/${from}`).set('authorization', 'Bearer alice')).body.balance_paise).toBe(
      '8750',
    );
    expect((await request(app).get(`/wallets/${to}`).set('authorization', 'Bearer bob')).body.balance_paise).toBe('1750');

    const stored = await request(app)
      .get(`/transfers/${response.body.id}`)
      .set('authorization', 'Bearer bob');
    expect(stored.status).toBe(200);
    expect(stored.body).toEqual(response.body);
  });

  it('durably declines an overdraft without changing either balance', async () => {
    const from = await createWallet(app, 'alice', 100);
    const to = await createWallet(app, 'bob', 25);
    const command = { from, to, amount_paise: 101, idempotency_key: 'too-large' };

    const response = await request(app).post('/transfers').set('authorization', 'Bearer alice').send(command);
    const replay = await request(app).post('/transfers').set('authorization', 'Bearer alice').send(command);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('declined');
    expect(response.body.decline_reason).toBe('insufficient_funds');
    expect(replay.body).toEqual(response.body);
    const balances = await pool.query<{ id: string; balance_paise: string }>(
      'SELECT id, balance_paise FROM wallets ORDER BY id',
    );
    expect(Object.fromEntries(balances.rows.map((row) => [row.id, row.balance_paise]))).toEqual({
      [from]: '100',
      [to]: '25',
    });
  });

  it('applies a 30-request idempotent retry storm exactly once', async () => {
    const from = await createWallet(app, 'alice', 10_000);
    const to = await createWallet(app, 'bob', 0);
    const command = { from, to, amount_paise: 1_000, idempotency_key: 'storm-key' };

    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        request(app).post('/transfers').set('authorization', 'Bearer alice').send(command),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(responses.map((response) => JSON.stringify(response.body)))).toHaveLength(1);
    expect((await pool.query("SELECT balance_paise::text FROM wallets WHERE id = $1", [from])).rows[0].balance_paise).toBe(
      '9000',
    );
    expect((await pool.query("SELECT balance_paise::text FROM wallets WHERE id = $1", [to])).rows[0].balance_paise).toBe(
      '1000',
    );
    expect((await pool.query("SELECT count(*)::text AS count FROM transfers WHERE idempotency_key = 'storm-key'")).rows[0].count).toBe(
      '1',
    );
  });

  it('returns 409 when an idempotency key is reused with a changed body', async () => {
    const from = await createWallet(app, 'alice', 10_000);
    const to = await createWallet(app, 'bob', 0);
    const first = await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer alice')
      .send({ from, to, amount_paise: 100, idempotency_key: 'conflict-key' });
    const conflict = await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer alice')
      .send({ from, to, amount_paise: 200, idempotency_key: 'conflict-key' });

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('idempotency_conflict');
    expect((await pool.query('SELECT balance_paise::text FROM wallets WHERE id = $1', [from])).rows[0].balance_paise).toBe(
      '9900',
    );
  });

  it('rejects unauthorized debits and malformed money commands', async () => {
    const from = await createWallet(app, 'alice', 100);
    const to = await createWallet(app, 'bob', 0);
    const unauthorized = await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer mallory')
      .send({ from, to, amount_paise: 1, idempotency_key: 'unauthorized-key' });
    const fractional = await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer alice')
      .send({ from, to, amount_paise: 1.5, idempotency_key: 'fractional-key' });
    const self = await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer alice')
      .send({ from, to: from, amount_paise: 1, idempotency_key: 'self-key' });

    expect(unauthorized.status).toBe(403);
    expect(fractional.status).toBe(400);
    expect(self.status).toBe(400);
  });
});

