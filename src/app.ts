import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Pool } from 'pg';

import { AppError } from './http/errors.js';
import { registerWalletRoutes } from './wallets/wallet-routes.js';

export interface CreateAppOptions {
  pool: Pool;
  logLevel?: string;
}

export function createApp({ pool }: CreateAppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_request, response) => {
    await pool.query('SELECT 1');
    response.status(200).json({ status: 'ok' });
  });

  registerWalletRoutes(app, pool);

  app.use((_request, response) => {
    response.status(404).json({ code: 'not_found', message: 'Route was not found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        code: 'invalid_request',
        message: 'Request validation failed',
        details: error.issues,
      });
      return;
    }
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response.status(400).json({ code: 'invalid_json', message: 'Request body is not valid JSON' });
      return;
    }
    response.status(500).json({ code: 'internal_error', message: 'An unexpected error occurred' });
  };
  app.use(errorHandler);

  return app;
}

