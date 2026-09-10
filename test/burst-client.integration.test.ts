import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import request from 'supertest';
import { createBurstClient } from '../scripts/burst-client.js';
import { createApp } from '../src/app.js';
import { createTestPool, resetDatabase } from './helpers/database.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) { server.close(); server.closeAllConnections(); await once(server, 'close'); }

it('retries an identical request after the server commits and the response is lost', async () => {
  const pool = await createTestPool(); await resetDatabase(pool);
  const app = createApp({ pool, logLevel: 'silent' });
  const from = (await request(app).post('/wallets').auth('alice', { type: 'bearer' }).send({ initial_balance_paise: 100 })).body.id as string;
  const to = (await request(app).post('/wallets').auth('bob', { type: 'bearer' }).send({ initial_balance_paise: 0 })).body.id as string;
  const observed: { method?: string; url?: string; authorization?: string; correlation: string | string[] | undefined; body: string }[] = [];
  const proxy = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    observed.push({ ...(req.method ? { method: req.method } : {}), ...(req.url ? { url: req.url } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), correlation: req.headers['x-correlation-id'], body });
    const result = await request(app).post('/transfers').set('authorization', req.headers.authorization!).set('content-type', 'application/json').send(body);
    // The real API has already committed. Simulate losing that response once.
    if (observed.length === 1) res.destroy();
    else { res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(result.text); }
  });
  try {
    const client = createBurstClient(await listen(proxy));
    const result = await client.request<{ status: string }>('POST', '/transfers', 'alice', { from, to, amount_paise: 10, idempotency_key: 'lost-response' });
    expect(result.status).toBe('completed');
    expect(observed).toHaveLength(2); expect(observed[1]).toEqual(observed[0]);
    expect(client.report()).toMatchObject({ logicalRequests: 1, attempts: 2, httpFailures: 0, transportFailures: 1, retries: 1 });
    expect((await pool.query('SELECT balance_paise FROM wallets WHERE id = $1', [from])).rows[0].balance_paise).toBe('90');
    expect((await pool.query('SELECT balance_paise FROM wallets WHERE id = $1', [to])).rows[0].balance_paise).toBe('10');
    expect((await pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBe(1);
  } finally { await close(proxy); await pool.end(); }
});

it('reports an HTTP failure without disguising it as a transport retry', async () => {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.writeHead(503); res.end('{"code":"unavailable"}'); });
  try {
    const client = createBurstClient(await listen(server));
    await expect(client.request('GET', '/health')).rejects.toThrow('HTTP 503');
    expect(calls).toBe(1);
    expect(client.report()).toMatchObject({ attempts: 1, httpFailures: 1, transportFailures: 0, retries: 0 });
  } finally { await close(server); }
});

it('counts an HTTP 503 immediately even if its response body is interrupted', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    if (calls > 1) { res.end('{}'); return; }
    res.writeHead(503, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{');
    setTimeout(() => res.destroy(), 30);
  });
  try {
    const client = createBurstClient(await listen(server));
    await expect(client.request('GET', '/health')).rejects.toThrow('HTTP 503');
    expect(calls).toBe(1);
    expect(client.report()).toMatchObject({ httpFailures: 1, statuses: { '503': 1 }, retries: 0 });
  } finally { await close(server); }
});
