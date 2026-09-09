import type { DestinationStream } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/observability/logger.js';
import { createTestPool, resetDatabase } from './helpers/database.js';

describe('observability', () => {
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

  it('threads a caller correlation ID through structured logs without exposing authorization', async () => {
    let output = '';
    const destination: DestinationStream = { write: (chunk) => (output += chunk) };
    const logger = createLogger('info', destination);
    const app = createApp({ pool, logger });

    const response = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer never-log-this-token')
      .set('x-correlation-id', 'corr-123')
      .send({ initial_balance_paise: 100 });

    expect(response.status).toBe(200);
    expect(response.headers['x-correlation-id']).toBe('corr-123');
    expect(output).not.toContain('never-log-this-token');
    const entries = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.some((entry) => entry.event === 'wallet.created' && entry.correlation_id === 'corr-123')).toBe(true);
  });

  it('generates a correlation ID when the caller does not provide one', async () => {
    const app = createApp({ pool, logLevel: 'silent' });
    const response = await request(app).get('/health');
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exports request measurements and required transfer-domain counters', async () => {
    const app = createApp({ pool, logLevel: 'silent' });
    const source = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer alice')
      .send({ initial_balance_paise: 100 });
    const destination = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer bob')
      .send({ initial_balance_paise: 0 });
    const completedCommand = {
      from: source.body.id,
      to: destination.body.id,
      amount_paise: 40,
      idempotency_key: 'metrics-completed',
    };
    await request(app).post('/transfers').set('authorization', 'Bearer alice').send(completedCommand);
    await request(app).post('/transfers').set('authorization', 'Bearer alice').send(completedCommand);
    await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer alice')
      .send({ ...completedCommand, amount_paise: 1_000, idempotency_key: 'metrics-declined' });
    await request(app).get('/missing-route');

    const response = await request(app).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('wallet_http_requests_total');
    expect(response.text).toContain('wallet_http_request_duration_seconds_bucket');
    expect(response.text).toContain('wallet_http_errors_total');
    expect(response.text).toContain('wallet_transfers_created_total 2');
    expect(response.text).toContain('wallet_transfers_declined_insufficient_funds_total 1');
    expect(response.text).toContain('wallet_idempotent_replays_total 1');
  });
});

