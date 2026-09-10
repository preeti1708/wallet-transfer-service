import type { DestinationStream } from 'pino';

export interface PublicLogEntry {
  time?: string;
  level?: number;
  event: string;
  correlation_id?: string;
  transfer_id?: string;
  reason?: string;
  error_code?: string;
  method?: string;
  route?: string;
  status_code?: number;
  duration_ms?: number;
  stages_ms?: Record<string, number>;
}

const performanceStages = new Set([
  'application.other',
  'database.health',
  'database.pool.acquire',
  'database.transaction.begin',
  'database.idempotency.reserve',
  'database.wallet.lock',
  'database.wallet.debit',
  'database.wallet.credit',
  'database.transfer.finalize',
  'database.transfer.read',
  'database.transaction.commit',
  'database.transaction.rollback',
  'database.idempotency.read',
  'database.wallet.insert',
  'database.wallet.read',
]);

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

function safeDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 300_000
    ? value
    : undefined;
}

function safeStages(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const stages: Record<string, number> = {};
  for (const [stage, rawDuration] of Object.entries(value)) {
    const duration = safeDuration(rawDuration);
    if (performanceStages.has(stage) && duration !== undefined) stages[stage] = duration;
  }
  return Object.keys(stages).length === 0 ? undefined : stages;
}

export interface PublicLogStore extends DestinationStream {
  entries(): PublicLogEntry[];
}

export function createPublicLogStore(capacity = 200): PublicLogStore {
  const buffer: PublicLogEntry[] = [];

  return {
    write(chunk: string) {
      for (const line of chunk.trim().split('\n')) {
        if (!line) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        const event = safeString(parsed.event);
        if (event === undefined || !/^(wallet|transfer|request|server)\./.test(event)) continue;

        const time = safeString(parsed.time);
        const correlationId = safeString(parsed.correlation_id);
        const transferId = safeString(parsed.transfer_id);
        const reason = safeString(parsed.reason);
        const errorCode = safeString(parsed.error_code);
        const method = safeString(parsed.method);
        const route = safeString(parsed.route);
        const durationMs = safeDuration(parsed.duration_ms);
        const stagesMs = safeStages(parsed.stages_ms);
        const statusCode = typeof parsed.status_code === 'number' && Number.isInteger(parsed.status_code)
          && parsed.status_code >= 100 && parsed.status_code <= 599 ? parsed.status_code : undefined;

        const entry: PublicLogEntry = {
          event,
          ...(time === undefined ? {} : { time }),
          ...(typeof parsed.level === 'number' ? { level: parsed.level } : {}),
          ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
          ...(transferId === undefined ? {} : { transfer_id: transferId }),
          ...(reason === undefined ? {} : { reason }),
          ...(errorCode === undefined ? {} : { error_code: errorCode }),
          ...(method === undefined ? {} : { method }),
          ...(route === undefined ? {} : { route }),
          ...(statusCode === undefined ? {} : { status_code: statusCode }),
          ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
          ...(stagesMs === undefined ? {} : { stages_ms: stagesMs }),
        };

        buffer.push(entry);
        if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
      }
    },
    entries() {
      return buffer.map((entry) => ({ ...entry }));
    },
  };
}
