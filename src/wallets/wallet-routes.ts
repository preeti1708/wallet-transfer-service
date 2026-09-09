import type { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';

import { requireUser } from '../http/auth.js';
import { getOrCreateWallet, getWalletForUser } from './wallet-repository.js';

const createWalletBody = z
  .object({
    initial_balance_paise: z.number().int().safe().nonnegative().default(0),
  })
  .strict();

const walletParams = z.object({ id: z.string().uuid() });

export function registerWalletRoutes(router: Router, pool: Pool): void {
  router.post('/wallets', async (request, response) => {
    const userId = requireUser(request);
    const body = createWalletBody.parse(request.body ?? {});
    const result = await getOrCreateWallet(pool, userId, body.initial_balance_paise);
    response.status(200).json(result.wallet);
  });

  router.get('/wallets/:id', async (request, response) => {
    const userId = requireUser(request);
    const { id } = walletParams.parse(request.params);
    response.status(200).json(await getWalletForUser(pool, id, userId));
  });
}

