import { describe, expect, it } from 'vitest';

import { parseBearer } from '../src/http/auth.js';

describe('parseBearer', () => {
  it('returns the opaque user identity from a bearer token', () => {
    expect(parseBearer('Bearer alice-123')).toBe('alice-123');
  });

  it.each([undefined, '', 'Basic alice', 'Bearer ', 'bearer alice'])('rejects invalid authorization %s', (header) => {
    let thrown: unknown;
    try {
      parseBearer(header);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });
});
