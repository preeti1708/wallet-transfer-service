import { randomUUID } from 'node:crypto';

class HttpFailure extends Error {}

export interface LatencySummary { samples: number; p50: number; p95: number; p99: number; max: number }
export function latencySummary(values: number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => Math.round((sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0) * 100) / 100;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) };
}

export function createBurstClient(baseUrl: string, timeoutMs = 120_000, maxRetries = 2) {
  const counts = { logicalRequests: 0, attempts: 0, httpFailures: 0, transportFailures: 0, protocolFailures: 0, retries: 0 };
  const statuses: Record<string, number> = {};
  const transportCodes: Record<string, number> = {};
  const attemptMs: number[] = []; const endToEndMs: number[] = [];
  return {
    report: () => ({ ...counts, statuses: { ...statuses }, transportCodes: { ...transportCodes }, attemptMs: latencySummary(attemptMs), endToEndMs: latencySummary(endToEndMs) }),
    async request<T>(method: 'GET' | 'POST', path: string, user?: string, body?: unknown): Promise<T> {
      const start = performance.now(); counts.logicalRequests++;
      // Serialize once. Retries preserve the method, URL, identity, exact body,
      // idempotency key AND correlation ID, including a lost response after commit.
      const serializedBody = body === undefined ? undefined : JSON.stringify(body);
      const headers = {
        ...(user ? { authorization: `Bearer ${user}` } : {}),
        ...(serializedBody === undefined ? {} : { 'content-type': 'application/json' }),
        'x-correlation-id': `burst-${randomUUID()}`,
      };
      try {
        for (let attempt = 0; ; attempt++) {
          counts.attempts++;
          const attemptStart = performance.now();
          let response: Response; let text: string;
          try {
            response = await fetch(`${baseUrl}${path}`, {
              method, headers, signal: AbortSignal.timeout(timeoutMs),
              ...(serializedBody === undefined ? {} : { body: serializedBody }),
            });
            statuses[response.status] = (statuses[response.status] ?? 0) + 1;
            if (!response.ok) {
              counts.httpFailures++;
              // Classify from headers even when an error response body resets.
              void response.body?.cancel().catch(() => undefined);
              throw new HttpFailure(`HTTP ${response.status}: ${method} ${path}`);
            }
            text = await response.text();
          } catch (error) {
            attemptMs.push(performance.now() - attemptStart);
            if (error instanceof HttpFailure) throw error;
            const cause = error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause ? error.cause.code : undefined;
            const code = typeof cause === 'string' && ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause)
              ? cause : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'OTHER';
            transportCodes[code] = (transportCodes[code] ?? 0) + 1;
            counts.transportFailures++;
            if (attempt >= maxRetries) throw new Error(`Transport retries exhausted: ${method} ${path}`, { cause: error });
            counts.retries++;
            await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
            continue;
          }
          attemptMs.push(performance.now() - attemptStart);
          try { return JSON.parse(text) as T; }
          catch { counts.protocolFailures++; throw new Error(`Invalid JSON response: ${method} ${path}`); }
        }
      } finally { endToEndMs.push(performance.now() - start); }
    },
  };
}
