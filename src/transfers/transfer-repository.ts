import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';

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
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function readReplay(client: PoolClient, command: TransferCommand): Promise<TransferResult> {
  const result = await client.query<TransferRow>(
    `
      SELECT id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise,
             status, decline_reason, created_at, updated_at
      FROM transfers
      WHERE idempotency_key = $1
    `,
    [command.idempotencyKey],
  );
  const existing = result.rows[0];
  if (!existing) throw new Error('Idempotency conflict resolved without a visible transfer');

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

async function finishTransfer(client: PoolClient, transferId: string): Promise<Transfer> {
  const result = await client.query<TransferRow>(
    `
      SELECT id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise,
             status, decline_reason, created_at, updated_at
      FROM transfers
      WHERE id = $1
    `,
    [transferId],
  );
  const transfer = result.rows[0];
  if (!transfer) throw new Error('Committed transfer row was not found');
  return serializeTransfer(transfer);
}

export async function createTransfer(pool: Pool, command: TransferCommand): Promise<TransferResult> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const locked = await client.query<LockedWalletRow>(
      `
        SELECT id, user_id
        FROM wallets
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE
      `,
      [[command.from, command.to]],
    );
    if (locked.rowCount !== 2) throw new NotFoundError('Wallet');
    const source = locked.rows.find((wallet) => wallet.id === command.from);
    if (source?.user_id !== command.userId) throw new ForbiddenError('Only the source wallet owner may transfer funds');

    const transferId = randomUUID();
    await client.query(
      `
        INSERT INTO transfers (
          id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status
        ) VALUES ($1, $2, $3, $4, $5, 'pending')
      `,
      [transferId, command.idempotencyKey, command.from, command.to, command.amountPaise.toString()],
    );

    const debit = await client.query(
      `
        UPDATE wallets
        SET balance_paise = balance_paise - $1, updated_at = now()
        WHERE id = $2 AND balance_paise >= $1
      `,
      [command.amountPaise.toString(), command.from],
    );

    if (debit.rowCount === 0) {
      await client.query(
        `
          UPDATE transfers
          SET status = 'declined', decline_reason = 'insufficient_funds', updated_at = now()
          WHERE id = $1
        `,
        [transferId],
      );
    } else {
      await client.query(
        `
          UPDATE wallets
          SET balance_paise = balance_paise + $1, updated_at = now()
          WHERE id = $2
        `,
        [command.amountPaise.toString(), command.to],
      );
      await client.query(
        `UPDATE transfers SET status = 'completed', updated_at = now() WHERE id = $1`,
        [transferId],
      );
    }

    const transfer = await finishTransfer(client, transferId);
    await client.query('COMMIT');
    transactionOpen = false;
    return { transfer, replay: false };
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK');
      transactionOpen = false;
    }
    if (isUniqueViolation(error)) {
      return await readReplay(client, command);
    }
    throw error;
  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

export async function getTransferForUser(pool: Pool, transferId: string, userId: string): Promise<Transfer> {
  const result = await pool.query<TransferRow>(
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
  const transfer = result.rows[0];
  if (!transfer) throw new NotFoundError('Transfer');
  return serializeTransfer(transfer);
}
