import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);

await runMigrations(pool);
const app = createApp({ pool, logLevel: config.logLevel });
const server = app.listen(config.port, config.host);

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ level: 'info', event: 'server.shutdown', signal }));
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

