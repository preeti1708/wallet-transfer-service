import { randomUUID } from 'node:crypto';

import express, { type ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import type { Pool } from 'pg';

import { AppError } from './http/errors.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { createPublicLogStore, type PublicLogStore } from './observability/public-log-store.js';
import { registerTransferRoutes } from './transfers/transfer-routes.js';
import { registerWalletRoutes } from './wallets/wallet-routes.js';

export interface CreateAppOptions {
  pool: Pool;
  logLevel?: string;
  logger?: Logger;
  publicLogs?: PublicLogStore;
  revision?: string;
}

const acceptedCorrelationId = /^[A-Za-z0-9._-]{1,128}$/;

function parserStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : undefined;
}

export function createApp(options: CreateAppOptions): express.Express {
  const { pool, logLevel = 'info' } = options;
  const publicLogs = options.publicLogs ?? createPublicLogStore();
  const logger = options.logger ?? createLogger(logLevel, undefined, publicLogs);
  const revision = /^[a-f0-9]{7,40}$/.test(options.revision ?? '') ? options.revision : 'development';
  const app = express();
  const metrics = createMetrics();
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      // Only request identifiers and methods are retained. Paths, query strings,
      // cookies, headers and bodies can contain secrets even on rejected requests.
      serializers: {
        req: (request) => ({ id: request.id, method: request.method }),
        res: (response) => ({ statusCode: response.statusCode }),
      },
      genReqId(request, response) {
        const requested = request.headers['x-correlation-id'];
        const id = typeof requested === 'string' && acceptedCorrelationId.test(requested) ? requested : randomUUID();
        response.setHeader('x-correlation-id', id);
        return id;
      },
      customProps(request) {
        return { correlation_id: request.id };
      },
      customLogLevel(_request, response, error) {
        if (error || response.statusCode >= 500) return 'error';
        if (response.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  app.use(metrics.middleware);
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    try {
      await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
      response.status(200).json({ status: 'ok', service: 'wallet-transfer-service', revision });
    } catch {
      response.status(503).json({ code: 'database_unavailable', message: 'Database readiness check failed', revision });
    }
  });

  app.get('/metrics', async (_request, response) => {
    response.setHeader('content-type', metrics.registry.contentType);
    response.status(200).send(await metrics.registry.metrics());
  });

  app.get('/logs', (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.status(200).json({ entries: publicLogs.entries() });
  });

  registerWalletRoutes(app, pool);
  registerTransferRoutes(app, pool, metrics);

  app.use((_request, response) => {
    response.status(404).json({ code: 'not_found', message: 'Route was not found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    void _next;
    if (error instanceof ZodError) {
      response.status(400).json({
        code: 'invalid_request',
        message: 'Request validation failed',
        details: error.issues,
      });
      return;
    }
    if (error instanceof AppError) {
      request.log.warn({ event: 'request.rejected', error_code: error.code }, error.message);
      response.status(error.statusCode).json({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }
    if (error instanceof Error && (
      error.message === 'timeout exceeded when trying to connect' ||
      ('code' in error && (error.code === '55P03' || error.code === '57014'))
    )) {
      request.log.warn({ event: 'request.rejected', error_code: 'database_busy' }, 'Database contention deadline exceeded');
      response.status(503).json({ code: 'database_busy', message: 'Database is busy. Retry with the original request and idempotency key.' });
      return;
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response.status(400).json({ code: 'invalid_json', message: 'Request body is not valid JSON' });
      return;
    }
    const status = parserStatus(error);
    if (status !== undefined) {
      const code = status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'invalid_request';
      const message = status === 413 ? 'Request body exceeds the 16kb limit' : 'Request body could not be processed';
      response.status(status).json({ code, message });
      return;
    }
    request.log.error({ event: 'request.failed', err: error }, 'Unexpected request failure');
    response.status(500).json({ code: 'internal_error', message: 'An unexpected error occurred' });
  };
  app.use(errorHandler);

  return app;
}
