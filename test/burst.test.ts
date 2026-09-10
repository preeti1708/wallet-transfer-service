import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

import { runBurst } from '../scripts/burst.js';
import { createApp } from '../src/app.js';
import { createTestPool, resetDatabase } from './helpers/database.js';

describe('one-command burst probe', () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    pool = await createTestPool();
    server = createApp({ pool, logLevel: 'silent' }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
    await pool.end();
  });

  it('proves get-or-create, idempotency, conservation, and no-overdraft', async () => {
    const report = await runBurst(baseUrl);

    expect(report.concurrentWallet.uniqueWallets).toBe(1);
    expect(report.idempotency.uniqueResponses).toBe(1);
    expect(report.idempotency.sourceBalance).toBe('9000');
    expect(report.idempotency.destinationBalance).toBe('11000');
    expect(report.contention.totalBefore).toBe('30000');
    expect(report.contention.totalAfter).toBe('30000');
    expect(report.contention.requests).toBe(300);
    expect(report.contention.declinedTransfers).toBe(34);
    expect(report.exhaustion).toMatchObject({ requests: 50, completed: 8, declined: 42, sourceBalance: '1', destinationBalance: '24', identicalReplays: true });
    expect(report.network).toMatchObject({ httpFailures: 0, protocolFailures: 0 });
    expect(report.network.retries).toBe(report.network.transportFailures);
    expect(report.network.attempts).toBe(report.network.logicalRequests + report.network.retries);
    expect(report.network.endToEndMs.p99).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM wallets')).rows[0].n).toBe(6);
    expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(351);
    expect(BigInt(report.contention.minimumBalance) >= 0n).toBe(true);
    expect(report.contention.failedRequests).toBe(0);
  });
});
