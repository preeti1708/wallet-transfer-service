import pino, { type DestinationStream, type Logger } from 'pino';

import type { PublicLogStore } from './public-log-store.js';

export function createLogger(level: string, destination?: DestinationStream, publicLogs?: PublicLogStore): Logger {
  const output =
    publicLogs === undefined
      ? destination
      : pino.multistream([{ stream: destination ?? process.stdout }, { stream: publicLogs }]);

  return pino(
    {
      level,
      base: { service: 'wallet-transfer-service' },
      serializers: {
        // PostgreSQL errors may embed credentials, SQL, or failing row data.
        err(error: unknown) {
          const code = typeof error === 'object' && error !== null && 'code' in error
            && typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : undefined;
          return { type: 'OperationalError', ...(code ? { code } : {}) };
        },
      },
      redact: {
        paths: ['req.headers.authorization', 'headers.authorization', 'authorization'],
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    output,
  );
}
