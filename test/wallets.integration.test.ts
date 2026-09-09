import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createApp } from '../src/app.js';
import { createTestPool, resetDatabase } from './helpers/database.js';

describe('wallet API', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await createTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates exactly one wallet during 50 concurrent get-or-create requests', async () => {
    const app = createApp({ pool, logLevel: 'silent' });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app)
          .post('/wallets')
          .set('authorization', 'Bearer concurrent-user')
          .send({ initial_balance_paise: 10_000 }),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.body.id))).toHaveLength(1);
    expect(responses.every((response) => response.body.balance_paise === '10000')).toBe(true);

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM wallets WHERE user_id = 'concurrent-user'",
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('uses initial balance only for the first creation', async () => {
    const app = createApp({ pool, logLevel: 'silent' });
    const first = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer alice')
      .send({ initial_balance_paise: 700 });
    const replay = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer alice')
      .send({ initial_balance_paise: 99_999 });

    expect(first.body).toMatchObject({ user_id: 'alice', balance_paise: '700' });
    expect(replay.body).toEqual(first.body);
  });

  it('returns a wallet to its owner and hides it from other users', async () => {
    const app = createApp({ pool, logLevel: 'silent' });
    const created = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer alice')
      .send({ initial_balance_paise: 400 });

    const owned = await request(app).get(`/wallets/${created.body.id}`).set('authorization', 'Bearer alice');
    const hidden = await request(app).get(`/wallets/${created.body.id}`).set('authorization', 'Bearer bob');

    expect(owned.status).toBe(200);
    expect(owned.body.balance_paise).toBe('400');
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('not_found');
  });

  it('validates authorization and integer paise', async () => {
    const app = createApp({ pool, logLevel: 'silent' });
    const unauthorized = await request(app).post('/wallets').send({ initial_balance_paise: 1 });
    const fractional = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer alice')
      .send({ initial_balance_paise: 1.5 });
    const negative = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer alice')
      .send({ initial_balance_paise: -1 });

    expect(unauthorized.status).toBe(401);
    expect(fractional.status).toBe(400);
    expect(negative.status).toBe(400);
  });
});

