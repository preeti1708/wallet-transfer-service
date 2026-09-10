import pg from 'pg';
import { createPool } from '../../src/db/pool.js';

// A child process catches unhandled pg EventEmitter errors as a nonzero exit.
const pool = createPool(process.env.TEST_DATABASE_URL!, 20);
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const client = await pool.connect();
const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
const mode = process.argv[2];
let pending: Promise<unknown> | undefined;
if (mode === 'active') pending = client.query('SELECT pg_sleep(10)').catch(() => undefined);
else client.release();
await admin.query('SELECT pg_terminate_backend($1)', [pid]);
if (pending) { await pending; client.release(true); }
// Let socket error delivery complete before testing a fresh connection.
await new Promise(resolve => setTimeout(resolve, 100));
const recovered = await pool.query('SELECT 1 AS value');
if (recovered.rows[0].value !== 1) throw new Error('Pool did not recover');
await Promise.all([pool.end(), admin.end()]);
process.stdout.write('recovered\n');
