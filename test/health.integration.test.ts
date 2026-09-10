import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestPool } from './helpers/database.js';

it('identifies the source revision and returns 503 when the database is unavailable', async () => {
  const pool = await createTestPool();
  const app = createApp({ pool, logLevel: 'silent', revision: '7144e8f375a3c3e929bed4683ebadcf21c7014fe' });
  const ready = await request(app).get('/health');
  expect(ready.status).toBe(200);
  expect(ready.body).toMatchObject({ status: 'ok', revision: '7144e8f375a3c3e929bed4683ebadcf21c7014fe' });
  await pool.end();
  const unavailable = await request(app).get('/health');
  expect(unavailable.status).toBe(503);
  expect(unavailable.body).toMatchObject({ code: 'database_unavailable' });
  expect(unavailable.headers['x-correlation-id']).toBeDefined();
});
