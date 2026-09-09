import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('rejects a missing database URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('parses supported runtime settings', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://wallet:wallet@localhost:5432/wallet',
        HOST: '127.0.0.1',
        PORT: '4321',
        LOG_LEVEL: 'debug',
      }),
    ).toEqual({
      databaseUrl: 'postgres://wallet:wallet@localhost:5432/wallet',
      host: '127.0.0.1',
      port: 4321,
      logLevel: 'debug',
    });
  });
});
