# Wallet Transfer Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a concurrency-safe Express/PostgreSQL wallet and peer-to-peer transfer API with deployment and observability assets.

**Architecture:** Express handlers delegate to focused PostgreSQL repositories that own transaction boundaries. Explicit SQL enforces unique wallet ownership, durable idempotency, sorted row locking, conditional debit, and atomic debit/credit; middleware owns authentication, correlation IDs, logs, errors, and metrics.

**Tech Stack:** Node.js 22+, TypeScript 7, Express 5, `pg`, Zod 4, Pino, `prom-client`, Vitest, Supertest, PostgreSQL 16, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-10-wallet-transfer-service-design.md`

## Global Constraints

- Money is PostgreSQL `BIGINT` integer paise and is serialized as a decimal string.
- Wallet `user_id` and transfer `idempotency_key` uniqueness are database-enforced.
- An idempotency row and its balance movement commit in the same transaction.
- Both wallets are locked in sorted UUID order before balance changes.
- Bearer credentials and database credentials must never appear in logs.
- The application runs as a non-root container user and exposes `/health` and `/metrics`.

---

### Task 1: Project foundation and database boundary

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/config.ts`, `src/db/pool.ts`, `src/db/migrate.ts`, `src/db/migrations/001_initial.sql`
- Create: `src/http/auth.ts`, `src/http/errors.ts`
- Test: `test/auth.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): Config`, `createPool(databaseUrl): Pool`, `runMigrations(pool): Promise<void>`, `requireUser(req): string`, and typed `AppError` subclasses.

- [ ] **Step 1: Write failing configuration and bearer-authentication tests**

```ts
expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
expect(parseBearer('Bearer alice')).toBe('alice');
expect(() => parseBearer('Basic alice')).toThrowErrorMatchingObject({ statusCode: 401 });
```

- [ ] **Step 2: Run tests and confirm failure because the modules do not exist**

Run: `npm test -- test/config.test.ts test/auth.test.ts`

- [ ] **Step 3: Implement the minimal configuration, auth, error, pool, migration runner, and schema**

```sql
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  user_id text NOT NULL UNIQUE,
  balance_paise bigint NOT NULL CHECK (balance_paise >= 0)
);
CREATE TABLE transfers (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  from_wallet_id uuid NOT NULL REFERENCES wallets(id),
  to_wallet_id uuid NOT NULL REFERENCES wallets(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL CHECK (status IN ('pending','completed','declined')),
  decline_reason text
);
```

- [ ] **Step 4: Run focused tests, typecheck, and commit**

Run: `npm test -- test/config.test.ts test/auth.test.ts && npm run typecheck`

### Task 2: Race-free wallet API

**Files:**
- Create: `src/wallets/wallet-repository.ts`, `src/wallets/wallet-routes.ts`
- Create: `src/app.ts`, `src/server.ts`
- Test: `test/wallets.integration.test.ts`

**Interfaces:**
- Consumes: `Pool`, `requireUser`, `AppError`.
- Produces: `getOrCreateWallet(pool, userId, initialBalance): Promise<Wallet>` and `getWalletForUser(pool, walletId, userId): Promise<Wallet>`.

- [ ] **Step 1: Write a failing integration test for 50 concurrent creates**

```ts
const responses = await Promise.all(Array.from({ length: 50 }, () =>
  request(app).post('/wallets').set('authorization', `Bearer ${user}`).send({ initial_balance_paise: 10000 })
));
expect(new Set(responses.map((r) => r.body.id))).toHaveLength(1);
expect(responses.every((r) => r.body.balance_paise === '10000')).toBe(true);
```

- [ ] **Step 2: Run it and confirm the missing-route failure**

Run: `npm test -- test/wallets.integration.test.ts`

- [ ] **Step 3: Implement `INSERT ... ON CONFLICT DO NOTHING` plus re-select, wallet authorization, routes, and health endpoint**

```sql
INSERT INTO wallets (id, user_id, balance_paise)
VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO NOTHING;
SELECT id, user_id, balance_paise FROM wallets WHERE user_id = $2;
```

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- test/wallets.integration.test.ts && npm run typecheck`

### Task 3: Exactly-once, conserved transfers

**Files:**
- Create: `src/transfers/transfer-repository.ts`, `src/transfers/transfer-routes.ts`
- Test: `test/transfers.integration.test.ts`, `test/contention.integration.test.ts`

**Interfaces:**
- Consumes: `Pool`, authenticated user ID, wallet IDs, safe positive amount, idempotency key.
- Produces: `createTransfer(pool, command): Promise<{ transfer: Transfer; replay: boolean }>` and `getTransferForUser(...)`.

- [ ] **Step 1: Write failing tests for a normal transfer, insufficient funds, retry storm, changed-body conflict, and authorization**

```ts
const retries = await Promise.all(Array.from({ length: 30 }, () => postTransfer(sameCommand)));
expect(new Set(retries.map((r) => r.body.id))).toHaveLength(1);
expect(await balances()).toEqual({ from: '9000', to: '1000' });
expect((await postTransfer({ ...sameCommand, amount_paise: 2000 })).status).toBe(409);
```

- [ ] **Step 2: Run tests and confirm missing-route failures**

Run: `npm test -- test/transfers.integration.test.ts`

- [ ] **Step 3: Implement the idempotency reservation and sorted wallet locks**

```sql
INSERT INTO transfers (...) VALUES (..., 'pending');
SELECT id, user_id, balance_paise
FROM wallets WHERE id = ANY($1::uuid[])
ORDER BY id FOR UPDATE;
```

- [ ] **Step 4: Implement conditional debit, credit, completed/declined status, duplicate recovery, and read route**

```sql
UPDATE wallets SET balance_paise = balance_paise - $1
WHERE id = $2 AND balance_paise >= $1;
UPDATE wallets SET balance_paise = balance_paise + $1 WHERE id = $2;
```

- [ ] **Step 5: Run transfer tests and verify green**

Run: `npm test -- test/transfers.integration.test.ts`

- [ ] **Step 6: Write and run the failing conservation test with concurrent A-to-B and B-to-A traffic, then make only required corrections**

Run: `npm test -- test/contention.integration.test.ts`

- [ ] **Step 7: Run all integration tests and commit**

Run: `npm test && npm run typecheck`

### Task 4: Structured logs and metrics

**Files:**
- Create: `src/observability/logger.ts`, `src/observability/metrics.ts`
- Modify: `src/app.ts`, wallet and transfer repositories/routes
- Test: `test/observability.test.ts`

**Interfaces:**
- Produces: correlation ID middleware, JSON domain event logger, HTTP histogram/counters, and Prometheus exposition handler.

- [ ] **Step 1: Write failing tests for correlation response headers, redacted authorization, request metrics, and domain counters**

```ts
expect(response.headers['x-correlation-id']).toBe('corr-123');
expect(await metrics()).toContain('wallet_http_requests_total');
expect(await metrics()).toContain('wallet_idempotent_replays_total');
```

- [ ] **Step 2: Run and confirm missing observability behavior**

Run: `npm test -- test/observability.test.ts`

- [ ] **Step 3: Implement logging and metrics middleware and domain events**

Use bounded route labels rather than raw URLs, histogram buckets suitable for API latency, and log `transfer.created`, `transfer.debited`, `transfer.credited`, `transfer.declined`, and `transfer.idempotent_replay` with correlation IDs.

- [ ] **Step 4: Run tests, typecheck, and commit**

Run: `npm test -- test/observability.test.ts && npm run typecheck`

### Task 5: Container, live probes, CI, and write-up

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`, `render.yaml`, `.env.example`
- Create: `scripts/burst.ts`, `.github/workflows/ci.yml`
- Create: `README.md`, `docs/WRITEUP.md`
- Test: `test/burst.test.ts`

**Interfaces:**
- Produces: `npm run burst -- <base-url>`, `docker compose up --build`, and complete candidate handoff documentation.

- [ ] **Step 1: Write a failing test that runs the burst probe against the application and asserts unique wallet IDs, identical retry transfer IDs, conserved total, and non-negative balances**

Run: `npm test -- test/burst.test.ts`

- [ ] **Step 2: Implement the one-command burst script**

The script creates uniquely named users, exercises 50 concurrent get-or-create calls, fires 30 identical transfer retries, runs bidirectional contention, and exits non-zero on any invariant violation.

- [ ] **Step 3: Add multi-stage non-root Dockerfile with HEALTHCHECK, Compose services, Render blueprint, and CI**

```dockerfile
FROM node:22-alpine AS build
RUN npm ci
RUN npm run build
FROM node:22-alpine AS runtime
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/health || exit 1
```

- [ ] **Step 4: Write the README and one-page reasoning document**

Document API examples, one-command startup and burst commands, schema, sorted lock rationale, atomic idempotency, rejected alternatives, consistency choice, metrics queries, AI directed-versus-decided disclosure, deployment steps, and the Rs.0 free-tier note.

- [ ] **Step 5: Run full verification and commit**

Run: `npm test && npm run lint && npm run typecheck && npm run build`

Run when Docker is available: `docker compose up --build -d && npm run burst -- http://localhost:3000 && docker compose down`
