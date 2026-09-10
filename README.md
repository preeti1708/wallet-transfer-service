# Wallet & P2P Transfer

A small TypeScript/Express service with PostgreSQL and explicit SQL through `pg`. It preserves money under contention, prevents overdrafts, commits durable idempotent outcomes, and creates one wallet per user. There is no front end or payment integration. All balances are exercise money.

- API: https://wallet-transfer-api.onrender.com
- Health: https://wallet-transfer-api.onrender.com/health
- Public sanitized logs: https://wallet-transfer-api.onrender.com/logs
- Metrics: https://wallet-transfer-api.onrender.com/metrics
- Repository: https://github.com/preeti1708/wallet-transfer-service
- [One-page write-up](docs/WRITEUP.md), [lock/failure reasoning](docs/CONCURRENCY.md), [verification record](docs/VERIFICATION.md), [session decisions and fixes](docs/SESSION.md)

## Start locally

Install Docker Engine with Compose, then:

```bash
docker compose up --build --wait
curl -fsS http://localhost:3000/health
```

Compose starts PostgreSQL, waits for database readiness, builds the image, and runs migrations before the API listens. The API is bound to loopback port 3000; PostgreSQL is not published. Use `API_PORT=3001 docker compose up --build --wait` if 3000 is occupied. Stop with `docker compose down`; its volume preserves data. `docker compose down -v` intentionally erases that Compose project's exercise database. Homebrew installations exposing Compose as `docker-compose` can use that spelling instead.

Node 24 LTS is the reference runtime (`nvm use`). Dependencies are pinned in `package-lock.json`; the container has a separate production-only dependency stage, runs as uid 1000, and has a port-aware database-backed HEALTHCHECK. To embed a local image revision, use:

```bash
SOURCE_REVISION=$(git rev-parse HEAD) docker compose up --build --wait
```

For host development with a separate local PostgreSQL:

```bash
npm ci
createdb wallet_dev
DATABASE_URL=postgresql://localhost/wallet_dev npm run migrate
DATABASE_URL=postgresql://localhost/wallet_dev npm run dev
```

## Configuration and migrations

| Variable | Default / use |
| --- | --- |
| `DATABASE_URL` | Required direct PostgreSQL connection URL. Keep it secret; never commit `.env`. |
| `HOST`, `PORT` | `0.0.0.0`, `3000`. Render supplies `PORT`. |
| `LOG_LEVEL` | `info`; accepts standard Pino levels or `silent`. |
| `SOURCE_REVISION` | Optional Git SHA embedded in the image or supplied at runtime. |
| `RENDER_GIT_COMMIT` | Render-supplied source SHA; used when `SOURCE_REVISION` is empty. |
| `TEST_DATABASE_URL` | Disposable database whose name ends in `_test`; tests truncate it. |
| `API_PORT` | Compose host port, default `3000`. |

`/health` checks the migration table using a database query and reports the non-sensitive source revision, or `development` for an unversioned local run. Database unavailability returns 503. Managed external connections must use provider-supported certificate validation (e.g. `sslmode=verify-full`); do not disable TLS verification. Compose and Render's same-region private endpoint use their local/private connection configuration.

Migrations in `src/db/migrations` are additive and tracked in `schema_migrations`. An advisory lock serializes concurrent migration runners. Each migration's SQL and history row commit together. Both `npm run migrate` and container startup use the same runner; failure stops startup. The existing managed database and historical migrations are retained.

## API and isolated seed data

A bearer token is the opaque exercise identity. Anyone who knows a token acts as that user; use freshly generated UUID tokens for isolated probes. This deliberately simple auth is not a production identity system. No real user accounts or financial funds are connected.

```bash
export BASE_URL=http://localhost:3000
export ALICE=$(node -e 'console.log(crypto.randomUUID())')
export BOB=$(node -e 'console.log(crypto.randomUUID())')

curl -sS "$BASE_URL/wallets" -H "Authorization: Bearer $ALICE" \
  -H 'Content-Type: application/json' -d '{"initial_balance_paise":10000}'
curl -sS "$BASE_URL/wallets" -H "Authorization: Bearer $BOB" \
  -H 'Content-Type: application/json' -d '{"initial_balance_paise":0}'
```

Save the returned wallet IDs as `ALICE_WALLET` and `BOB_WALLET`. The optional initial balance applies **only to the winning INSERT**. Repeating `POST /wallets`, even with a larger initial amount after a debit, never changes the stored balance. This first-create field is the documented exercise seeding mechanism; omitted funding defaults to zero. Creating new funded wallets increases the exercise supply; transfers alone conserve it.

```bash
curl -sS "$BASE_URL/wallets/$ALICE_WALLET" -H "Authorization: Bearer $ALICE"

curl -sS "$BASE_URL/transfers" -H "Authorization: Bearer $ALICE" \
  -H 'Content-Type: application/json' -H 'x-correlation-id: example-transfer-1' \
  -d "{\"from\":\"$ALICE_WALLET\",\"to\":\"$BOB_WALLET\",\"amount_paise\":1250,\"idempotency_key\":\"$(node -e 'console.log(crypto.randomUUID())')\"}"
```

Retain the exact transfer body and key when retrying. `GET /transfers/TRANSFER_ID` permits either participant. Wallet reads permit only the owner. Transfers and replays permit only the source owner.

| Endpoint | Response |
| --- | --- |
| `POST /wallets` | 200: existing or new wallet; money as a decimal string |
| `GET /wallets/:id` | 200: current owned wallet, or 404 |
| `POST /transfers` | 200: stored `completed` or `declined` result; identical replay body |
| `GET /transfers/:id` | 200: stored participant-visible transfer, or 404 |

Inputs are JSON numbers: funding must be a non-negative safe integer; transfers a positive safe integer, at most `9007199254740991` paise. Fractions, negative values, zero transfers, numeric strings and unsafe numbers are rejected. Storage and calculations use PostgreSQL BIGINT/JS BigInt; monetary outputs are always decimal strings, including balances above JavaScript's safe integer range. UUID spelling is normalized to lowercase; endpoints must be distinct. Idempotency keys are globally unique, 1–128 characters (excluding PostgreSQL-incompatible NUL); existing Unicode and whitespace keys remain supported. JSON requests are capped at 16 KiB and unknown fields are rejected.

Errors have `{ "code": "...", "message": "..." }` and optional validation details: 400 invalid request/JSON; 401 missing token; 403 unauthorized debit/replay; 404 absent or hidden resource; 409 changed request on an owned key; 413 oversized body; 415 unsupported body encoding; 500 unexpected failure. Insufficient funds is a durable `declined/insufficient_funds` result, not an HTTP error. Recipient BIGINT overflow is `declined/destination_balance_limit`, also durable. All responses carry `x-correlation-id`.

The existing [Postman collection](postman/Wallet%20Transfer%20Service.postman_collection.json) is preserved for manual examples. The burst runner below is the authoritative repeatable concurrency probe.

## Tests and one-command burst

```bash
createdb wallet_transfer_test
export TEST_DATABASE_URL=postgresql://localhost/wallet_transfer_test
npm run lint
npm run typecheck
npm test
npm run build

npm run burst -- http://localhost:3000
npm run burst -- https://wallet-transfer-api.onrender.com \
  --creates 50 --replays 30 --transfers 300 --exhaustion 50 \
  --out docs/evidence/live-burst.json
```

The runner generates fresh secret identities and keys on every run, waits for health, fires each phase concurrently, and verifies wallet uniqueness, identical responses, exact per-wallet debits/credits, conservation and non-negative balances. Its separate exhaustion phase sends 50 individually affordable 3-paise debits against 25 paise: exactly 8 complete and 42 decline; replaying all 50 must preserve their original bodies and balances. Default contention has 300 transfers among three wallets in both directions, including 34 deliberate overdrafts.

Options: `--creates`, `--replays`, `--transfers`, `--exhaustion` (minimum 9), `--timeout-ms` (default 120000), `--retries` (default 2), `--out`. Every run saves timestamped success/failure JSON and exits nonzero for a failed invariant or exhausted request. HTTP errors, transport failures, transport retries and invalid JSON responses are reported separately. Retries reuse the exact serialized body, identity, key and correlation ID. HTTP errors are not automatically retried. End-to-end client latency includes retries/backoff and network time; per-attempt latency excludes backoff. Phase durations are reported separately; initial readiness includes cold-start time.

Local integration tests use real PostgreSQL and also verify DB row counts, rollback on injected credit/commit errors, actual backend termination, one-connection-pool replay, exact BIGINT values, validation, authorization and replay after replenishment/process reconstruction. A real HTTP proxy drops a response after COMMIT to verify the lost-response case.

Verify a **committed clean checkout**, not the current uncommitted tree:

```bash
./scripts/verify-clean.sh
```

This archives HEAD into a fresh directory, installs dependencies in Node 24, runs lint/typecheck/tests/build against a disposable PostgreSQL database, builds and health-checks Compose, verifies uid/runtime dependencies, runs the burst, checks database counts, saves evidence, and removes only its own temporary containers/volume. CI runs these checks and retains evidence as an artifact. Test databases must end in `_test`; never point tests at the live database.

## Observability

Structured JSON request and domain logs accept a safe `x-correlation-id` (1–128 letters/digits/`.`/`_`/`-`) or generate a UUID. Request logs omit URL/query/header/body data; error logs expose only safe error codes. Domain events emitted after commit include `transfer.created`, `transfer.debited`, `transfer.credited`, `transfer.declined`, and `transfer.idempotent_replay`.

`/logs` returns at most 200 recent sanitized domain entries with `Cache-Control: no-store`. It includes event/correlation/transfer identifiers and outcomes, excluding identities, wallet IDs, amounts, bodies and credentials. It is an ephemeral, single-process demonstration feed; snapshots retained in verification evidence preserve burst observations. Private operational logs remain available through Render. Do not place sensitive information in correlation IDs.

`/metrics` uses bounded method, route-template and HTTP-status labels; no user, key or raw-path labels. PromQL examples for a Prometheus scraper:

```promql
# Request rate; exclude operational endpoints when assessing business traffic.
sum(rate(wallet_http_requests_total{route=~"/wallets.*|/transfers.*"}[5m]))
# 5xx error fraction (4xx input/auth errors can be queried separately).
sum(rate(wallet_http_requests_total{status_code=~"5.."}[5m])) / sum(rate(wallet_http_requests_total[5m]))
# Server-side transfer p99, including pool/lock waits but excluding network/cold-start.
histogram_quantile(0.99, sum by (le) (rate(wallet_http_request_duration_seconds_bucket{route="/transfers"}[5m])))
# Committed outcomes and replay rates.
sum(rate(wallet_transfers_created_total[5m]))
sum(rate(wallet_transfers_declined_insufficient_funds_total[5m]))
sum(rate(wallet_idempotent_replays_total[5m]))
```

`wallet_http_errors_total` counts 4xx and 5xx; domain declines remain HTTP 200. Histograms and counters are process-local and reset on restart. Retained verification includes histogram tail coverage; client p99 is a separate measurement. Logs and counters can be lost in a crash after commit and are not the financial source of truth.

## Deployment and ₹0 limits

The existing Render service builds this repository's Dockerfile and runs its image, backed by the existing managed PostgreSQL 16 database. `render.yaml` declares Free plans. Deploy the desired source revision through Render's Manual Deploy flow, wait for the database-backed health check, then verify `/health.revision` against the commit and run the live burst. Migrations run at startup because free services do not support paid predeploy/one-off job features. Never select a paid instance to bypass a free-tier limit.

Verified September 10, 2026: the signed-in workspace is Hobby; API and database are Free; no payment card is on file; accrued total was $0. Render provides 750 instance hours/month, sleep after 15 idle minutes (cold start roughly a minute), and a 1 GB free database expiring **October 10, 2026**, without backups. This workspace showed 5 GB/month included bandwidth. No-card overages suspend service/builds rather than enable paid usage. These limits make this an exercise deployment, not persistent production hosting. [Render free-tier documentation](https://render.com/docs/free), [Render pricing](https://render.com/pricing), [supported PostgreSQL versions](https://www.postgresql.org/support/versioning/), [Node release lifecycle](https://nodejs.org/en/about/previous-releases).
