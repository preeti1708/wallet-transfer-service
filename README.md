# Wallet Transfer Service

A concurrency-safe Express and PostgreSQL API for wallets and peer-to-peer transfers. Money is stored only as integer paise, and PostgreSQL transactions enforce conservation, no overdrafts, exactly-once idempotency, and race-free wallet creation.

## Run with one command

```bash
docker compose up --build
```

The API is available at `http://localhost:3000`. The application runs its idempotent migration at startup. Verify readiness with:

```bash
curl http://localhost:3000/health
```

## API

The bearer token is an opaque exercise user identity. Use a different token for each user.

```bash
# Get or create Alice's wallet. The initial balance applies only on first creation.
curl -sS -X POST http://localhost:3000/wallets \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"initial_balance_paise":10000}'

# Read a wallet owned by Alice.
curl -sS http://localhost:3000/wallets/WALLET_UUID \
  -H 'Authorization: Bearer alice'

# Transfer integer paise from Alice to another wallet.
curl -sS -X POST http://localhost:3000/transfers \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"from":"SOURCE_UUID","to":"DESTINATION_UUID","amount_paise":1250,"idempotency_key":"checkout-123"}'

# Either participant can read the transfer.
curl -sS http://localhost:3000/transfers/TRANSFER_UUID \
  -H 'Authorization: Bearer alice'
```

Wallet and transfer amounts are returned as decimal strings so API responses remain exact across the full PostgreSQL `BIGINT` range. Incoming amounts must be non-negative safe integers for initial balances and positive safe integers for transfers.

## Live correctness probe

With the service running, reproduce all three graded concurrency probes in one command:

```bash
npm run burst -- http://localhost:3000
```

The script fires 50 concurrent wallet creates, 30 concurrent repeats of one transfer, and 180 contended transfers—including opposite directions and deliberate overdrafts. It exits non-zero if wallet uniqueness, identical idempotent responses, conservation, or non-negative balances fails. Transient transport resets are retried with the same idempotency keys, exercising the retry contract under network failure.

## Observability

Every request accepts or generates `x-correlation-id`. Logs are newline-delimited JSON and redact authorization values. Domain events include:

- `wallet.created` and `wallet.replay`
- `transfer.created`
- `transfer.debited` and `transfer.credited`
- `transfer.declined` with `insufficient_funds`
- `transfer.idempotent_replay`

Prometheus metrics are exposed at `/metrics`:

- `wallet_http_requests_total` — request rate
- `wallet_http_request_duration_seconds` — latency histogram; calculate p99 with `histogram_quantile(0.99, sum by (le) (rate(wallet_http_request_duration_seconds_bucket[5m])))`
- `wallet_http_errors_total` — error rate
- `wallet_transfers_created_total`
- `wallet_transfers_declined_insufficient_funds_total`
- `wallet_idempotent_replays_total`

## Local development

Requirements: Node.js 22+, npm, and PostgreSQL 16.

```bash
npm ci
createdb wallet_transfer_test
export DATABASE_URL=postgresql://localhost/wallet_transfer_test
export TEST_DATABASE_URL="$DATABASE_URL"
npm run migrate
npm test
npm run dev
```

Quality checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Deploy on Render

`render.yaml` declares a free Docker web service and free managed PostgreSQL database. Push this repository to a Git provider, create a Render Blueprint from it, and apply the Blueprint. Render injects `DATABASE_URL`; the container runs migrations before accepting traffic, and `/health` verifies database connectivity.

Free Render PostgreSQL expires after 30 days and has no backups, so this configuration is suitable only for the exercise. After deployment, run the burst command against the `onrender.com` URL and use the Render Logs page as the public/live log evidence.

The concise design rationale and AI-use disclosure are in [docs/WRITEUP.md](docs/WRITEUP.md).

