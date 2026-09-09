# Wallet Transfer Service — Design and Operations Write-up

## Data model

`wallets` has a UUID primary key, unique `user_id`, checked non-negative `BIGINT balance_paise`, and timestamps. `transfers` stores a UUID, unique client idempotency key, both wallet IDs, a checked positive `BIGINT` amount, durable `completed` or `declined` status, optional decline reason, and timestamps. The API returns money as decimal strings, avoiding floating-point and JSON safe-integer ambiguity.

The optional initial balance exists only to seed this exercise. `POST /wallets` attempts `INSERT ... ON CONFLICT (user_id) DO NOTHING`, then re-selects the wallet. Only the winning insert can create the initial balance; retries cannot mint funds.

## Simplest-correct money movement

Each transfer uses one PostgreSQL transaction. It locks both wallet rows with one `SELECT ... ORDER BY id FOR UPDATE`, so every request acquires shared wallet pairs in deterministic UUID order. This removes the A-to-B/B-to-A deadlock cycle. The debit is still a conditional `UPDATE ... WHERE balance_paise >= amount`; zero affected rows produces a durable `declined/insufficient_funds` transfer without either balance changing. A successful debit, destination credit, and completed transfer status commit together. Rollback removes all of them together, preserving conservation.

I rejected reading a balance in Node and writing a replacement because concurrent writers cause lost updates. I rejected unsorted locks because opposite transfers can deadlock. Serializable isolation is correct but heavier here: it adds abort/retry handling without simplifying this small, explicit invariant. A conditional debit followed by an unlocked credit was also rejected because opposite-direction updates can deadlock and make reasoning less uniform.

## Exactly-once placement

PostgreSQL—not process memory—enforces global uniqueness on `transfers.idempotency_key`. The unique row is inserted in the same transaction as the debit and credit, before wallet locks; deferrable wallet foreign keys allow missing-wallet validation to remain inside that transaction. Concurrent duplicates wait on the unique constraint; after the winner commits, losers roll back their attempted transaction and read the committed result using their already checked-out connection. That last detail avoids connection-pool starvation during retry storms. The original `from`, `to`, and amount are stored and compared; a changed request returns HTTP 409 instead of reusing or applying it, and replay lookup rechecks source ownership.

## Consistency, availability, and operation

This money workload chooses consistency. If PostgreSQL, a required row lock, or the transaction outcome is unavailable, the API fails rather than acknowledging an uncertain movement. That gives up write availability during database outages and adds latency under contention, but it prevents silent double-spends and ambiguous balances.

The image is multi-stage, runs as the non-root `node` user, and includes a database-backed health check. Docker Compose starts the API and PostgreSQL together. JSON logs carry correlation IDs through request and domain events while redacting bearer values. Prometheus counters expose request/error rates and domain outcomes; a histogram supports p99 latency queries. The one-command burst script exercises wallet creation, retry storms, opposite-direction contention, overdrafts, conservation, and transport retries.

## AI disclosure and cost

Directed by the human: the goal, TypeScript/Node choice, Express framework, and approval of the proposed architecture. Decided and typed by AI: raw `pg` boundaries, schema details, sorted-lock plus conditional-debit implementation, test strategy, observability wiring, container/Compose assets, Render Blueprint, probe script, and documentation. These choices remain visible in code and should be reviewed and explained by the submitter rather than presented as unaided work.

The declared Render web service and managed PostgreSQL use free plans, so the exercise cost is Rs.0 with no card. The trade-off is that free web instances can sleep and free PostgreSQL expires after 30 days with no backups; it is not a production configuration.
