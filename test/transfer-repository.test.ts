import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';

import { createTransfer } from '../src/transfers/transfer-repository.js';

const transferRow = {
  id: '00000000-0000-4000-8000-000000000003',
  idempotency_key: 'fast-path',
  from_wallet_id: '00000000-0000-4000-8000-000000000001',
  to_wallet_id: '00000000-0000-4000-8000-000000000002',
  amount_paise: '100',
  status: 'completed' as const,
  decline_reason: null,
  created_at: new Date('2026-09-10T00:00:00.000Z'),
  updated_at: new Date('2026-09-10T00:00:00.000Z'),
};

function result(rows: unknown[] = [], rowCount = rows.length): QueryResult {
  return { command: '', fields: [], oid: 0, rows, rowCount } as QueryResult;
}

describe('transfer repository critical section', () => {
  it('uses one database round trip after locking wallets and before commit', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      statements.push(normalized);

      if (normalized.includes('FOR UPDATE')) {
        return result([
          { id: transferRow.from_wallet_id, user_id: 'alice', balance_paise: '1000' },
          { id: transferRow.to_wallet_id, user_id: 'bob', balance_paise: '0' },
        ]);
      }
      if (normalized.startsWith('WITH moved_wallets AS')) return result([transferRow]);
      if (normalized.startsWith('SELECT id, idempotency_key')) return result([transferRow]);
      return result([], normalized.startsWith('UPDATE') ? 1 : 0);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    const response = await createTransfer(pool, {
      userId: 'alice',
      from: transferRow.from_wallet_id,
      to: transferRow.to_wallet_id,
      amountPaise: 100,
      idempotencyKey: transferRow.idempotency_key,
    });

    expect(response).toMatchObject({ replay: false, transfer: { status: 'completed', amount_paise: '100' } });
    const lockIndex = statements.findIndex((sql) => sql.includes('FOR UPDATE'));
    const commitIndex = statements.indexOf('COMMIT');
    expect(statements.slice(lockIndex + 1, commitIndex)).toHaveLength(1);
  });
});
