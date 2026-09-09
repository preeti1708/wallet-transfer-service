import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { NotFoundError } from '../http/errors.js';

interface WalletRow {
  id: string;
  user_id: string;
  balance_paise: string;
  created_at: Date;
  updated_at: Date;
}

export interface Wallet {
  id: string;
  user_id: string;
  balance_paise: string;
  created_at: string;
  updated_at: string;
}

function serializeWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    user_id: row.user_id,
    balance_paise: row.balance_paise,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function getOrCreateWallet(
  pool: Pool,
  userId: string,
  initialBalancePaise: number,
): Promise<{ wallet: Wallet; created: boolean }> {
  const inserted = await pool.query<WalletRow>(
    `
      INSERT INTO wallets (id, user_id, balance_paise)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
      RETURNING id, user_id, balance_paise, created_at, updated_at
    `,
    [randomUUID(), userId, initialBalancePaise.toString()],
  );

  const insertedWallet = inserted.rows[0];
  if (insertedWallet) {
    return { wallet: serializeWallet(insertedWallet), created: true };
  }

  const existing = await pool.query<WalletRow>(
    `
      SELECT id, user_id, balance_paise, created_at, updated_at
      FROM wallets
      WHERE user_id = $1
    `,
    [userId],
  );
  const existingWallet = existing.rows[0];
  if (!existingWallet) {
    throw new Error('Wallet conflict resolved without a visible wallet');
  }

  return { wallet: serializeWallet(existingWallet), created: false };
}

export async function getWalletForUser(pool: Pool, walletId: string, userId: string): Promise<Wallet> {
  const result = await pool.query<WalletRow>(
    `
      SELECT id, user_id, balance_paise, created_at, updated_at
      FROM wallets
      WHERE id = $1 AND user_id = $2
    `,
    [walletId, userId],
  );
  const wallet = result.rows[0];
  if (!wallet) throw new NotFoundError('Wallet');
  return serializeWallet(wallet);
}
