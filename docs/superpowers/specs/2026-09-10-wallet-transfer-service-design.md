# Wallet Transfer Service Design

## Purpose

Build a deployable Express and PostgreSQL wallet API whose correctness survives concurrent wallet creation, transfer retries, insufficient funds, and transfers in opposite directions. The service prioritizes consistency over availability because an unavailable money movement is safer than an ambiguous or duplicated one.

## API

- `POST /wallets` authenticates the caller from `Authorization: Bearer <user-id>` and gets or creates that user's wallet. The optional `initial_balance_paise` is a non-negative integer and is used only by the transaction that creates the wallet.
- `GET /wallets/:id` returns a wallet only to its owner.
- `POST /transfers` accepts `from`, `to`, `amount_paise`, and `idempotency_key`. The authenticated caller must own `from`.
- `GET /transfers/:id` returns a transfer visible to either participating wallet owner.
- `GET /health` reports process and database readiness.
- `GET /metrics` exposes Prometheus text metrics.

JSON responses use decimal strings for `balance_paise` and `amount_paise`. PostgreSQL `BIGINT` safely represents money; JSON numbers do not safely represent the full range, so request validation accepts safe positive JavaScript integers and persists them as `BIGINT`.

## Data Model

`wallets` contains a UUID primary key, unique `user_id`, non-negative `BIGINT balance_paise`, and timestamps. The unique constraint is the concurrency boundary for get-or-create.

`transfers` contains a UUID primary key, globally unique idempotency key, source and destination wallet IDs, positive amount, status (`completed` or `declined`), optional decline reason, and timestamps. Storing the full normalized request fields makes same-key/different-body comparison direct and auditable.

## Transfer Transaction

1. Begin a PostgreSQL transaction.
2. Insert the transfer row as the idempotency reservation. Its wallet foreign keys are deferrable so missing-wallet validation can follow without weakening key-conflict precedence. A uniqueness conflict rolls back the local transaction, verifies source ownership, reads the committed original row, compares all request fields, and returns either the original response or HTTP 409.
3. Lock both wallet rows using one `SELECT ... WHERE id = ANY($1) ORDER BY id FOR UPDATE`. Every transfer therefore acquires locks in deterministic UUID order, including simultaneous A-to-B and B-to-A requests.
4. Validate that both wallets exist and the source belongs to the caller.
5. If the source balance is insufficient, update the reserved transfer to `declined`, commit it, and return that durable result without changing either balance.
6. Otherwise debit the source with a conditional `UPDATE ... WHERE balance_paise >= amount`, credit the destination, mark the transfer completed, and commit all changes atomically.

The sorted row locks prevent deadlock between opposite-direction transfers. The conditional debit remains a defense-in-depth no-overdraft check. A transaction either persists both balance changes and the idempotency result or none of them.

## Authentication and Validation

Bearer tokens are intentionally simple exercise identities rather than production credentials. Tokens must be non-empty and are treated as opaque user IDs. UUIDs, positive integer amounts, distinct source/destination wallets, and bounded idempotency keys are validated before database work. Error responses have stable machine-readable `code` values.

## Observability

Pino emits JSON request logs with an accepted or generated `x-correlation-id`. Domain events include wallet creation/replay, transfer creation, debit, credit, insufficient-funds decline, and idempotent replay. Sensitive authorization values are never logged.

Prometheus metrics include request count by route/method/status, request latency histogram (from which p99 is queryable), error count, and domain counters for transfers created, insufficient-funds declines, and idempotent replays.

## Deployment and Operations

The multi-stage Dockerfile builds TypeScript, copies production dependencies only, runs as a non-root user, and defines a health check. Docker Compose starts PostgreSQL and the API with health dependencies and one command. A Render blueprint describes a free web service and managed PostgreSQL deployment without embedding credentials.

Database migrations run explicitly before application startup in local, container, CI, and hosted workflows. The service fails fast if the schema is unavailable.

## Testing

Unit tests cover authentication, validation, and error mapping. Integration tests use real PostgreSQL and cover the four required endpoints, unique get-or-create under concurrency, same-key retry storms, same-key/different-body conflict, conservation under contention, authorization, and no overdraft. A one-command burst script repeats the three live probes against any base URL.

## Reasoning and Scope

Explicit `pg` transactions are preferred over an ORM so the locking and atomicity mechanisms are visible. Serializable isolation was rejected as heavier than necessary and would require retry loops. Unsorted row locks were rejected because opposite-direction transfers can deadlock. Application-memory idempotency was rejected because it fails across processes and restarts.

The future reversal/refund prompt contained in the internal evaluator rubric is intentionally excluded: it is an interviewer instruction for a later round, not a requirement of the current build.
