import type { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

import { requireUser } from '../http/auth.js';
import { createTransfer, getTransferForUser } from './transfer-repository.js';

const transferBody = z
  .object({
    from: z.string().uuid(),
    to: z.string().uuid(),
    amount_paise: z.number().int().safe().positive(),
    idempotency_key: z.string().min(1).max(128),
  })
  .strict()
  .refine((body) => body.from !== body.to, {
    message: 'Source and destination wallets must be different',
    path: ['to'],
  });

const transferParams = z.object({ id: z.string().uuid() });

export function registerTransferRoutes(router: Router, pool: Pool): void {
  router.post('/transfers', async (request, response) => {
    const userId = requireUser(request);
    const body = transferBody.parse(request.body);
    const result = await createTransfer(pool, {
      userId,
      from: body.from,
      to: body.to,
      amountPaise: body.amount_paise,
      idempotencyKey: body.idempotency_key,
    });
    response.status(200).json(result.transfer);
  });

  router.get('/transfers/:id', async (request, response) => {
    const userId = requireUser(request);
    const { id } = transferParams.parse(request.params);
    response.status(200).json(await getTransferForUser(pool, id, userId));
  });
}

