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
    expect(report.contention.minimumBalance >= 0n).toBe(true);
    expect(report.contention.failedRequests).toBe(0);
  });
});
