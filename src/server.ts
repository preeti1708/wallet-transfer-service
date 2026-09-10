import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';
import { createLogger } from './observability/logger.js';
import { createPublicLogStore } from './observability/public-log-store.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, config.databasePoolMax);
const publicLogs = createPublicLogStore();
const logger = createLogger(config.logLevel, undefined, publicLogs);

try {
  await runMigrations(pool);
} catch (error) {
  logger.fatal({ event: 'server.startup_failed', err: error }, 'Database migration failed');
  await pool.end();
  process.exit(1);
}
const revision = process.env.SOURCE_REVISION || process.env.RENDER_GIT_COMMIT;
const app = createApp({ pool, logger, publicLogs, ...(revision ? { revision } : {}) });
const server = app.listen(config.port, config.host);
server.once('listening', () => logger.info({ event: 'server.started', port: config.port, revision }, 'Wallet service started'));
server.once('error', (error) => {
  logger.fatal({ event: 'server.listen_failed', err: error }, 'Unable to listen');
  void pool.end().finally(() => process.exit(1));
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ event: 'server.shutdown', signal }, 'Wallet service shutting down');
  setTimeout(() => {
    logger.error({ event: 'server.shutdown_timeout' }, 'Shutdown deadline exceeded');
    process.exit(1);
  }, 35_000).unref();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
