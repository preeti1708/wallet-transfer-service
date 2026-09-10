import type { Pool, PoolClient } from 'pg';

import type { RequestTelemetry } from '../observability/request-telemetry.js';

export async function withPoolClient<T>(
  pool: Pool,
  telemetry: RequestTelemetry | undefined,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const acquire = () => pool.connect();
  const client = await (telemetry?.measure('database.pool.acquire', acquire) ?? acquire());
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}
