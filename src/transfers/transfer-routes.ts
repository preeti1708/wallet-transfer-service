import type { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

import { requireUser } from '../http/auth.js';
import type { Metrics } from '../observability/metrics.js';
import { createTransfer, getTransferForUser } from './transfer-repository.js';

const transferBody = z
  .object({
    from: z.string().uuid().toLowerCase(),
    to: z.string().uuid().toLowerCase(),
    amount_paise: z.number().int().safe().positive(),
    idempotency_key: z.string().min(1).max(128).refine(key => !key.includes('\0'), 'NUL is not supported in PostgreSQL text'),
  })
  .strict()
  .refine((body) => body.from !== body.to, {
    message: 'Source and destination wallets must be different',
    path: ['to'],
  });

const transferParams = z.object({ id: z.string().uuid() });

export function registerTransferRoutes(router: Router, pool: Pool, metrics: Metrics): void {
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
    if (result.replay) {
      metrics.idempotentReplay();
      request.log.info(
        { event: 'transfer.idempotent_replay', transfer_id: result.transfer.id },
        'Idempotent transfer result returned',
      );
    } else {
      metrics.transferCreated();
      request.log.info({ event: 'transfer.created', transfer_id: result.transfer.id }, 'Transfer created');
      if (result.transfer.status === 'declined') {
        if (result.transfer.decline_reason === 'insufficient_funds') metrics.transferDeclinedInsufficientFunds();
        request.log.info(
          {
            event: 'transfer.declined',
            transfer_id: result.transfer.id,
            reason: result.transfer.decline_reason,
          },
          'Transfer declined',
        );
      } else {
        request.log.info(
          { event: 'transfer.debited', transfer_id: result.transfer.id, wallet_id: result.transfer.from },
          'Source wallet debited',
        );
        request.log.info(
          { event: 'transfer.credited', transfer_id: result.transfer.id, wallet_id: result.transfer.to },
          'Destination wallet credited',
        );
      }
    }
    response.status(200).json(result.transfer);
  });

  router.get('/transfers/:id', async (request, response) => {
    const userId = requireUser(request);
    const { id } = transferParams.parse(request.params);
    response.status(200).json(await getTransferForUser(pool, id, userId));
  });
}
