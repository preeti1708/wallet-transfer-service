import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';

import { createApp } from '../src/app.js';
import { createTestPool, resetDatabase } from './helpers/database.js';

async function createWallet(app: Express, user: string): Promise<string> {
  const response = await request(app)
    .post('/wallets')
    .set('authorization', `Bearer ${user}`)
    .send({ initial_balance_paise: 10_000 });
  return response.body.id as string;
}

describe('conservation under contention', () => {
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

  it('preserves total money and non-negative balances during bidirectional transfers', async () => {
    const wallets = [
      { user: 'alice', id: await createWallet(app, 'alice') },
      { user: 'bob', id: await createWallet(app, 'bob') },
      { user: 'carol', id: await createWallet(app, 'carol') },
    ];

    const commands = Array.from({ length: 240 }, (_, index) => {
      const source = wallets[index % wallets.length]!;
      const destination = wallets[(index + 1 + (index % 2)) % wallets.length]!;
      return {
        user: source.user,
        body: {
          from: source.id,
          to: destination.id,
          amount_paise: index % 8 === 0 ? 30_001 : 7,
          idempotency_key: `contention-${index}`,
        },
      };
    });

    const responses = await Promise.all(
      commands.map(({ user, body }) =>
        request(app).post('/transfers').set('authorization', `Bearer ${user}`).send(body),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => ['completed', 'declined'].includes(response.body.status))).toBe(true);
    expect(responses.some((response) => response.body.status === 'declined')).toBe(true);

    const balances = await pool.query<{ balance_paise: string }>(
      'SELECT balance_paise::text FROM wallets ORDER BY id',
    );
    expect(balances.rows.reduce((total, row) => total + BigInt(row.balance_paise), 0n)).toBe(30_000n);
    expect(balances.rows.every((row) => BigInt(row.balance_paise) >= 0n)).toBe(true);

    const counts = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM transfers');
    expect(counts.rows[0]?.count).toBe('240');
  });
});
