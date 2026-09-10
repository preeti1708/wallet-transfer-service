import type { DestinationStream } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/observability/logger.js';
import { createPublicLogStore } from '../src/observability/public-log-store.js';
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

  it('publishes a bounded sanitized domain log feed', async () => {
    let output = '';
    const destination: DestinationStream = { write: (chunk) => (output += chunk) };
    const publicLogs = createPublicLogStore(10);
    const logger = createLogger('info', destination, publicLogs);
    const app = createApp({ pool, logger, publicLogs });

    await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer public-feed-secret')
      .set('x-correlation-id', 'public-log-correlation')
      .send({ initial_balance_paise: 100 });

    const response = await request(app).get('/logs');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.entries).toContainEqual(
      expect.objectContaining({
        event: 'wallet.created',
        correlation_id: 'public-log-correlation',
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain('public-feed-secret');
    expect(response.body.entries.map((entry: { event: string }) => entry.event).sort()).toEqual([
      'request.performance',
      'wallet.created',
    ]);
  });

  it('publishes a correlated request performance event with total and database stage durations', async () => {
    let output = '';
    const destination: DestinationStream = { write: (chunk) => (output += chunk) };
    const publicLogs = createPublicLogStore(10);
    const logger = createLogger('info', destination, publicLogs);
    const app = createApp({ pool, logger, publicLogs });

    const health = await request(app).get('/health').set('x-correlation-id', 'health-performance');
    const logs = await request(app).get('/logs');
    const metrics = await request(app).get('/metrics');

    expect(health.status).toBe(200);
    expect(logs.body.entries).toContainEqual(expect.objectContaining({
      event: 'request.performance',
      correlation_id: 'health-performance',
      method: 'GET',
      route: '/health',
      status_code: 200,
      duration_ms: expect.any(Number),
      stages_ms: expect.objectContaining({
        'database.pool.acquire': expect.any(Number),
        'database.health': expect.any(Number),
        'application.other': expect.any(Number),
      }),
    }));
    expect(metrics.text).toContain('wallet_api_stage_duration_seconds_bucket');
    expect(metrics.text).toContain('route="/health",stage="database.health",outcome="success"');
    expect(metrics.text).toContain('route="/health",stage="application.other",outcome="success"');
  });

  it('attributes wallet insert and read time to their API routes', async () => {
    const publicLogs = createPublicLogStore(20);
    const logger = createLogger('info', { write: () => undefined }, publicLogs);
    const app = createApp({ pool, logger, publicLogs });

    const created = await request(app)
      .post('/wallets')
      .set('authorization', 'Bearer telemetry-wallet-user')
      .set('x-correlation-id', 'wallet-create-performance')
      .send({ initial_balance_paise: 100 });
    await request(app)
      .get(`/wallets/${created.body.id}`)
      .set('authorization', 'Bearer telemetry-wallet-user')
      .set('x-correlation-id', 'wallet-read-performance');
    const logs = await request(app).get('/logs');
    const metrics = await request(app).get('/metrics');

    expect(logs.body.entries).toContainEqual(expect.objectContaining({
      event: 'request.performance',
      correlation_id: 'wallet-create-performance',
      stages_ms: expect.objectContaining({
        'database.pool.acquire': expect.any(Number),
        'database.wallet.insert': expect.any(Number),
      }),
    }));
    expect(logs.body.entries).toContainEqual(expect.objectContaining({
      event: 'request.performance',
      correlation_id: 'wallet-read-performance',
      stages_ms: expect.objectContaining({
        'database.pool.acquire': expect.any(Number),
        'database.wallet.read': expect.any(Number),
      }),
    }));
    expect(metrics.text).toContain('route="/wallets",stage="database.wallet.insert",outcome="success"');
    expect(metrics.text).toContain('route="/wallets/:id",stage="database.wallet.read",outcome="success"');
  });

  it('attributes every successful transfer database stage without high-cardinality metric labels', async () => {
    const publicLogs = createPublicLogStore(30);
    const logger = createLogger('info', { write: () => undefined }, publicLogs);
    const app = createApp({ pool, logger, publicLogs });
    const source = await request(app).post('/wallets').set('authorization', 'Bearer transfer-source')
      .send({ initial_balance_paise: 100 });
    const destination = await request(app).post('/wallets').set('authorization', 'Bearer transfer-destination')
      .send({ initial_balance_paise: 0 });

    const transfer = await request(app)
      .post('/transfers')
      .set('authorization', 'Bearer transfer-source')
      .set('x-correlation-id', 'transfer-performance')
      .send({
        from: source.body.id,
        to: destination.body.id,
        amount_paise: 10,
        idempotency_key: 'transfer-performance-key',
      });
    await request(app)
      .get(`/transfers/${transfer.body.id}`)
      .set('authorization', 'Bearer transfer-source')
      .set('x-correlation-id', 'transfer-read-performance');
    const logs = await request(app).get('/logs');
    const metrics = await request(app).get('/metrics');
    const performance = logs.body.entries.find(
      (entry: { event: string; correlation_id?: string }) =>
        entry.event === 'request.performance' && entry.correlation_id === 'transfer-performance',
    );

    expect(transfer.status).toBe(200);
    expect(performance).toMatchObject({
      method: 'POST',
      route: '/transfers',
      status_code: 200,
      stages_ms: {
        'database.pool.acquire': expect.any(Number),
        'database.transaction.begin': expect.any(Number),
        'database.idempotency.reserve': expect.any(Number),
        'database.wallet.lock': expect.any(Number),
        'database.transfer.finalize': expect.any(Number),
        'database.transaction.commit': expect.any(Number),
      },
    });
    expect(performance.stages_ms).not.toHaveProperty('database.wallet.debit');
    expect(performance.stages_ms).not.toHaveProperty('database.wallet.credit');
    expect(performance.stages_ms).not.toHaveProperty('database.transfer.read');
    expect(logs.body.entries).toContainEqual(expect.objectContaining({
      event: 'request.performance',
      correlation_id: 'transfer-read-performance',
      route: '/transfers/:id',
      stages_ms: expect.objectContaining({
        'database.pool.acquire': expect.any(Number),
        'database.transfer.read': expect.any(Number),
      }),
    }));
    expect(metrics.text).toContain('route="/transfers",stage="database.wallet.lock",outcome="success"');
    expect(metrics.text).toContain('route="/transfers/:id",stage="database.transfer.read",outcome="success"');
    expect(metrics.text).not.toContain(source.body.id);
    expect(metrics.text).not.toContain('transfer-performance-key');
  });

  it('records failed stages, rollback, and replay lookup for an idempotent transfer replay', async () => {
    const publicLogs = createPublicLogStore(40);
    const logger = createLogger('info', { write: () => undefined }, publicLogs);
    const app = createApp({ pool, logger, publicLogs });
    const source = await request(app).post('/wallets').set('authorization', 'Bearer replay-source')
      .send({ initial_balance_paise: 100 });
    const destination = await request(app).post('/wallets').set('authorization', 'Bearer replay-destination')
      .send({ initial_balance_paise: 0 });
    const body = {
      from: source.body.id,
      to: destination.body.id,
      amount_paise: 10,
      idempotency_key: 'replay-performance-key',
    };
    await request(app).post('/transfers').set('authorization', 'Bearer replay-source').send(body);
    await request(app).post('/transfers').set('authorization', 'Bearer replay-source')
      .set('x-correlation-id', 'replay-performance').send(body);
    const logs = await request(app).get('/logs');
    const metrics = await request(app).get('/metrics');
    const replayPerformance = logs.body.entries.find(
      (entry: { event: string; correlation_id?: string }) =>
        entry.event === 'request.performance' && entry.correlation_id === 'replay-performance',
    );

    expect(replayPerformance).toMatchObject({
      stages_ms: {
        'database.pool.acquire': expect.any(Number),
        'database.transaction.begin': expect.any(Number),
        'database.idempotency.reserve': expect.any(Number),
        'database.transaction.rollback': expect.any(Number),
        'database.idempotency.read': expect.any(Number),
      },
    });
    expect(metrics.text).toContain('route="/transfers",stage="database.idempotency.reserve",outcome="error"');
    expect(metrics.text).toContain('route="/transfers",stage="database.transaction.rollback",outcome="success"');
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

describe('operational data minimization', () => {
  it('excludes query secrets, cookies, arbitrary headers and database error details from logs', async () => {
    let output = '';
    const pool = await createTestPool();
    try {
      const logger = createLogger('info', { write: chunk => { output += chunk; } });
      const app = createApp({ pool, logger });
      await request(app).get('/missing?token=secret-query-value')
        .set('cookie', 'session=secret-cookie-value').set('x-api-key', 'secret-api-key-value');
      logger.error({ err: Object.assign(new Error('postgresql://user:secret-database-value@host/db'), { detail: 'sensitive-row-value', code: '08006' }) }, 'Database unavailable');
      for (const secret of ['secret-query-value', 'secret-cookie-value', 'secret-api-key-value', 'secret-database-value', 'sensitive-row-value']) expect(output).not.toContain(secret);
      expect(output).toContain('08006');
    } finally { await pool.end(); }
  });
});
