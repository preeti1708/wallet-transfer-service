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
      redact: {
        paths: ['req.headers.authorization', 'headers.authorization', 'authorization'],
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    output,
  );
}
