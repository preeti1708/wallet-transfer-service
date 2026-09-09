import type { Request } from 'express';

import { UnauthorizedError } from './errors.js';

const bearerPattern = /^Bearer ([^\s]+)$/;

export function parseBearer(header: string | undefined): string {
  const match = header?.match(bearerPattern);
  if (!match?.[1]) {
    throw new UnauthorizedError();
  }

  return match[1];
}

export function requireUser(request: Request): string {
  return parseBearer(request.header('authorization'));
}

