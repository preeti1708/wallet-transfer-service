import pino, { type DestinationStream, type Logger } from 'pino';

export function createLogger(level: string, destination?: DestinationStream): Logger {
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
    destination,
  );
}
