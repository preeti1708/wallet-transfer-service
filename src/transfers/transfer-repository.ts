import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withPoolClient } from '../db/instrumented-client.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import type { ApiStage, RequestTelemetry } from '../observability/request-telemetry.js';

interface TransferRow {
  id: string;
  idempotency_key: string;
  from_wallet_id: string;
  to_wallet_id: string;
  amount_paise: string;
  status: 'pending' | 'completed' | 'declined';
  decline_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LockedWalletRow {
  id: string;
  user_id: string;
  balance_paise: string;
}

interface ReplayRow extends TransferRow {
  source_user_id: string;
}

export interface Transfer {
  id: string;
  idempotency_key: string;
  from: string;
  to: string;
  amount_paise: string;
  status: 'completed' | 'declined';
  decline_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferCommand {
  userId: string;
  from: string;
  to: string;
  amountPaise: number;
  idempotencyKey: string;
}

export interface TransferResult {
  transfer: Transfer;
  replay: boolean;
}

function serializeTransfer(row: TransferRow): Transfer {
  if (row.status === 'pending') {
    throw new Error(`Transfer ${row.id} is unexpectedly pending`);
  }
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    from: row.from_wallet_id,
    to: row.to_wallet_id,
    amount_paise: row.amount_paise,
    status: row.status,
    decline_reason: row.decline_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
    && 'constraint' in error && error.constraint === 'transfers_idempotency_key_key';
}

function measure<T>(
  telemetry: RequestTelemetry | undefined,
  stage: ApiStage,
  operation: () => Promise<T>,
): Promise<T> {
  return telemetry?.measure(stage, operation) ?? operation();
}

async function readReplay(
  client: PoolClient,
  command: TransferCommand,
  telemetry?: RequestTelemetry,
): Promise<TransferResult> {
  const result = await measure(telemetry, 'database.idempotency.read', () => client.query<ReplayRow>(
    `
      SELECT t.id, t.idempotency_key, t.from_wallet_id, t.to_wallet_id, t.amount_paise,
             t.status, t.decline_reason, t.created_at, t.updated_at,
             source.user_id AS source_user_id
      FROM transfers t
      JOIN wallets source ON source.id = t.from_wallet_id
      WHERE t.idempotency_key = $1
    `,
    [command.idempotencyKey],
  ));
  const existing = result.rows[0];
  if (!existing) throw new Error('Idempotency conflict resolved without a visible transfer');
  if (existing.source_user_id !== command.userId) {
    throw new ForbiddenError('Only the source wallet owner may transfer funds');
  }

  const sameRequest =
    existing.from_wallet_id === command.from &&
    existing.to_wallet_id === command.to &&
    existing.amount_paise === command.amountPaise.toString();
  if (!sameRequest) {
    throw new ConflictError(
      'idempotency_conflict',
      'The idempotency key was already used with a different transfer request',
    );
  }

  return { transfer: serializeTransfer(existing), replay: true };
}

async function applyTransferOutcome(
  client: PoolClient,
  transferId: string,
  command: TransferCommand,
  completed: boolean,
  declineReason: string | null,
  telemetry?: RequestTelemetry,
): Promise<Transfer> {
  const result = await measure(telemetry, 'database.transfer.finalize', () => client.query<TransferRow>(
    `
      WITH moved_wallets AS (
        UPDATE wallets
        SET balance_paise = CASE
              WHEN id = $2::uuid THEN balance_paise - $1::bigint
              ELSE balance_paise + $1::bigint
            END,
            updated_at = now()
        WHERE $4::boolean
          AND id = ANY(ARRAY[$2::uuid, $3::uuid])
          AND EXISTS (
            SELECT 1
            FROM wallets source
            WHERE source.id = $2::uuid
              AND source.balance_paise >= $1::bigint
          )
        RETURNING id
      ), finalized_transfer AS (
        UPDATE transfers
        SET status = CASE WHEN $4::boolean THEN 'completed' ELSE 'declined' END,
            decline_reason = CASE WHEN $4::boolean THEN NULL ELSE $5::text END,
            updated_at = now()
        WHERE id = $6::uuid
          AND (
            NOT $4::boolean
            OR (SELECT count(*) FROM moved_wallets) = 2
          )
        RETURNING id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise,
                  status, decline_reason, created_at, updated_at
      )
      SELECT id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise,
             status, decline_reason, created_at, updated_at
      FROM finalized_transfer
    `,
    [
      command.amountPaise.toString(),
      command.from,
      command.to,
      completed,
      declineReason,
      transferId,
    ],
  ));
  const transfer = result.rows[0];
  if (!transfer) throw new Error('Transfer outcome could not be applied');
  return serializeTransfer(transfer);
}

export async function createTransfer(
  pool: Pool,
  command: TransferCommand,
  telemetry?: RequestTelemetry,
): Promise<TransferResult> {
  const client = await measure(telemetry, 'database.pool.acquire', () => pool.connect());
  let transactionOpen = false;
  let discardClient = false;
  try {
    await measure(telemetry, 'database.transaction.begin', () => client.query('BEGIN'));
    transactionOpen = true;

    const transferId = randomUUID();
    await measure(telemetry, 'database.idempotency.reserve', () => client.query(
      `
        INSERT INTO transfers (
          id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status
        ) VALUES ($1, $2, $3, $4, $5, 'pending')
      `,
      [transferId, command.idempotencyKey, command.from, command.to, command.amountPaise.toString()],
    ));

    const locked = await measure(telemetry, 'database.wallet.lock', () => client.query<LockedWalletRow>(
      `
        SELECT id, user_id, balance_paise
        FROM wallets
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE
      `,
      [[command.from, command.to]],
    ));
    if (locked.rowCount !== 2) throw new NotFoundError('Wallet');
    const source = locked.rows.find((wallet) => wallet.id === command.from);
    if (source?.user_id !== command.userId) throw new ForbiddenError('Only the source wallet owner may transfer funds');
    const destination = locked.rows.find((wallet) => wallet.id === command.to)!;
    const amount = BigInt(command.amountPaise);
    // Both balances are read under our sorted row locks. Insufficient funds takes
    // precedence; a recipient overflow is also a durable, replayable decline.
    const destinationOverflow = BigInt(source.balance_paise) >= amount
      && BigInt(destination.balance_paise) > 9_223_372_036_854_775_807n - amount;
    const completed = BigInt(source.balance_paise) >= amount && !destinationOverflow;
    const declineReason = completed
      ? null
      : destinationOverflow ? 'destination_balance_limit' : 'insufficient_funds';
    const transfer = await applyTransferOutcome(
      client,
      transferId,
      command,
      completed,
      declineReason,
      telemetry,
    );
    await measure(telemetry, 'database.transaction.commit', () => client.query('COMMIT'));
    transactionOpen = false;
    return { transfer, replay: false };
  } catch (error) {
    if (transactionOpen) {
      try {
        await measure(telemetry, 'database.transaction.rollback', () => client.query('ROLLBACK'));
      } catch {
        discardClient = true;
      }
    }
    if (!discardClient && isUniqueViolation(error)) {
      return await readReplay(client, command, telemetry);
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

export async function getTransferForUser(
  pool: Pool,
  transferId: string,
  userId: string,
  telemetry?: RequestTelemetry,
): Promise<Transfer> {
  return withPoolClient(pool, telemetry, async client => {
    const operation = () => client.query<TransferRow>(
      `
        SELECT t.id, t.idempotency_key, t.from_wallet_id, t.to_wallet_id, t.amount_paise,
               t.status, t.decline_reason, t.created_at, t.updated_at
        FROM transfers t
        JOIN wallets source ON source.id = t.from_wallet_id
        JOIN wallets destination ON destination.id = t.to_wallet_id
        WHERE t.id = $1 AND (source.user_id = $2 OR destination.user_id = $2)
      `,
      [transferId, userId],
    );
    const result = await measure(telemetry, 'database.transfer.read', operation);
    const transfer = result.rows[0];
    if (!transfer) throw new NotFoundError('Transfer');
    return serializeTransfer(transfer);
  });
}
