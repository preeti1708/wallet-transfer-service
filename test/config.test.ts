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
        DATABASE_POOL_MAX: '40',
      }),
    ).toEqual({
      databaseUrl: 'postgres://wallet:wallet@localhost:5432/wallet',
      host: '127.0.0.1',
      port: 4321,
      logLevel: 'debug',
      databasePoolMax: 40,
    });
  });

  it('defaults to 40 connections and rejects values unsafe for overlapping deploys', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://localhost/wallet' }).databasePoolMax).toBe(40);
    expect(() => loadConfig({
      DATABASE_URL: 'postgres://localhost/wallet',
      DATABASE_POOL_MAX: '41',
    })).toThrow(/DATABASE_POOL_MAX/);
  });
});
