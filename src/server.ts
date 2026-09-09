import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';
import { createLogger } from './observability/logger.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const logger = createLogger(config.logLevel);

await runMigrations(pool);
const app = createApp({ pool, logger });
const server = app.listen(config.port, config.host);
logger.info({ event: 'server.started', host: config.host, port: config.port }, 'Wallet service started');

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: 'server.shutdown', signal }, 'Wallet service shutting down');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
