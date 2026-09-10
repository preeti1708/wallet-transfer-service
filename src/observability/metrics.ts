import type { RequestHandler } from 'express';
import { Counter, Histogram, Registry } from '@prometheus-io/client';

import type { StageMeasurement } from './request-telemetry.js';

export interface Metrics {
  registry: Registry;
  middleware: RequestHandler;
  transferCreated(): void;
  transferDeclinedInsufficientFunds(): void;
  idempotentReplay(): void;
  observeStage(route: string, measurement: StageMeasurement): void;
}

function routeLabel(request: Parameters<RequestHandler>[0]): string {
  const routePath = request.route?.path;
  return typeof routePath === 'string' ? `${request.baseUrl}${routePath}` || '/' : 'unmatched';
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  const requests = new Counter({
    name: 'wallet_http_requests_total',
    help: 'Total HTTP requests handled by the wallet service.',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });
  const errors = new Counter({
    name: 'wallet_http_errors_total',
    help: 'Total HTTP responses with a 4xx or 5xx status.',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });
  const latency = new Histogram({
    name: 'wallet_http_request_duration_seconds',
    help: 'HTTP request duration in seconds. Use histogram_quantile(0.99, ...) for p99.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 7.5, 10, 15, 30, 60],
    registers: [registry],
  });
  const stageLatency = new Histogram({
    name: 'wallet_api_stage_duration_seconds',
    help: 'Duration of fixed internal API stages in seconds.',
    labelNames: ['route', 'stage', 'outcome'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const transfersCreated = new Counter({
    name: 'wallet_transfers_created_total',
    help: 'Durable transfer records created, including completed and declined transfers.',
    registers: [registry],
  });
  const insufficientFunds = new Counter({
    name: 'wallet_transfers_declined_insufficient_funds_total',
    help: 'Transfers declined because the source wallet had insufficient funds.',
    registers: [registry],
  });
  const replays = new Counter({
    name: 'wallet_idempotent_replays_total',
    help: 'Transfer requests served from an existing idempotency result.',
    registers: [registry],
  });

  const middleware: RequestHandler = (request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.once('finish', () => {
      const labels = {
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER',
        route: routeLabel(request),
        status_code: response.statusCode.toString(),
      };
      requests.inc(labels);
      latency.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
      if (response.statusCode >= 400) errors.inc(labels);
    });
    next();
  };

  return {
    registry,
    middleware,
    transferCreated: () => transfersCreated.inc(),
    transferDeclinedInsufficientFunds: () => insufficientFunds.inc(),
    idempotentReplay: () => replays.inc(),
    observeStage: (route, measurement) => stageLatency.observe(
      { route, stage: measurement.stage, outcome: measurement.outcome },
      measurement.durationSeconds,
    ),
  };
}
