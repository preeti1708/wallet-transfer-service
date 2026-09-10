import type { RequestHandler, Response } from 'express';

export type ApiStage =
  | 'application.other'
  | 'database.health'
  | 'database.pool.acquire'
  | 'database.transaction.begin'
  | 'database.idempotency.reserve'
  | 'database.wallet.lock'
  | 'database.wallet.debit'
  | 'database.wallet.credit'
  | 'database.transfer.finalize'
  | 'database.transfer.read'
  | 'database.transaction.commit'
  | 'database.transaction.rollback'
  | 'database.idempotency.read'
  | 'database.wallet.insert'
  | 'database.wallet.read';

export type StageOutcome = 'success' | 'error';

export interface StageMeasurement {
  stage: ApiStage;
  outcome: StageOutcome;
  durationSeconds: number;
}

export interface RequestTelemetry {
  measure<T>(stage: ApiStage, operation: () => Promise<T>): Promise<T>;
}

export type StageObserver = (route: string, measurement: StageMeasurement) => void;

interface RequestTelemetryState extends RequestTelemetry {
  measurements: StageMeasurement[];
}

const telemetryKey = 'walletRequestTelemetry';

function routeLabel(request: Parameters<RequestHandler>[0]): string {
  const routePath = request.route?.path;
  return typeof routePath === 'string' ? `${request.baseUrl}${routePath}` || '/' : 'unmatched';
}

function roundMilliseconds(seconds: number): number {
  return Math.round(seconds * 1_000_000) / 1_000;
}

export function telemetryFor(response: Response): RequestTelemetry {
  const telemetry = response.locals[telemetryKey] as RequestTelemetryState | undefined;
  if (telemetry === undefined) {
    return { measure: (_stage, operation) => operation() };
  }
  return telemetry;
}

export function createRequestTelemetryMiddleware(observeStage?: StageObserver): RequestHandler {
  return (request, response, next) => {
    const startedAt = process.hrtime.bigint();
    const measurements: StageMeasurement[] = [];
    const telemetry: RequestTelemetryState = {
      measurements,
      async measure(stage, operation) {
        const stageStartedAt = process.hrtime.bigint();
        try {
          const result = await operation();
          measurements.push({
            stage,
            outcome: 'success',
            durationSeconds: Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000_000,
          });
          return result;
        } catch (error) {
          measurements.push({
            stage,
            outcome: 'error',
            durationSeconds: Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000_000,
          });
          throw error;
        }
      },
    };
    response.locals[telemetryKey] = telemetry;
    response.once('finish', () => {
      const route = routeLabel(request);
      const totalDurationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const measuredDurationSeconds = measurements.reduce(
        (total, measurement) => total + measurement.durationSeconds,
        0,
      );
      const allMeasurements = [
        ...measurements,
        {
          stage: 'application.other' as const,
          outcome: 'success' as const,
          durationSeconds: Math.max(0, totalDurationSeconds - measuredDurationSeconds),
        },
      ];
      const stagesMs: Record<string, number> = {};
      for (const measurement of allMeasurements) {
        observeStage?.(route, measurement);
        stagesMs[measurement.stage] = roundMilliseconds(
          (stagesMs[measurement.stage] ?? 0) / 1000 + measurement.durationSeconds,
        );
      }
      request.log.info(
        {
          event: 'request.performance',
          method: request.method,
          route,
          status_code: response.statusCode,
          duration_ms: roundMilliseconds(totalDurationSeconds),
          stages_ms: stagesMs,
        },
        'Request performance measured',
      );
    });
    next();
  };
}
