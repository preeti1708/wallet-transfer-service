import type { DestinationStream } from 'pino';

export interface PublicLogEntry {
  time?: string;
  level?: number;
  event: string;
  correlation_id?: string;
  transfer_id?: string;
  reason?: string;
  error_code?: string;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
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

        const entry: PublicLogEntry = {
          event,
          ...(time === undefined ? {} : { time }),
          ...(typeof parsed.level === 'number' ? { level: parsed.level } : {}),
          ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
          ...(transferId === undefined ? {} : { transfer_id: transferId }),
          ...(reason === undefined ? {} : { reason }),
          ...(errorCode === undefined ? {} : { error_code: errorCode }),
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
