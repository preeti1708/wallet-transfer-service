# Transaction and failure reasoning

## Full lock sequence

The API uses PostgreSQL READ COMMITTED. One `pg` client owns a transfer transaction from BEGIN through COMMIT/ROLLBACK. No in-memory map, queue or mutex is an authority for money or idempotency.

1. `INSERT transfers(..., status='pending')` reserves the **global** idempotency key in the database unique index. The random primary UUID also has a unique index. A duplicate key waits for the inserting transaction's outcome. Wallet foreign keys are `DEFERRABLE INITIALLY DEFERRED` (migration 002), so this insert does **not** yet take foreign-key `KEY SHARE` locks on wallet rows.
2. The winning insertion selects the two wallets with `ORDER BY id FOR UPDATE`. PostgreSQL sorts the UUIDs before LockRows acquires the row locks. Every transfer uses the same order regardless of debit direction. Rows are verified to exist, and the source owner is checked while the locks are held. Failure rolls back the reserved key.
3. Under those locks, the service checks the recipient's BIGINT capacity and executes `UPDATE wallets ... WHERE balance_paise >= amount` for the debit. Insufficient funds changes only the transfer to a durable decline. Recipient overflow also becomes a durable decline. Successful debit and credit update the already-locked rows. PostgreSQL CHECK constraints also prohibit negative balances and nonpositive amounts.
4. The transfer becomes `completed` or `declined`; its response is serialized **inside** the transaction. COMMIT runs the deferred wallet foreign-key checks. Their `KEY SHARE` requests are satisfied by this transaction's already-held, stronger `FOR UPDATE` locks. Migration 003's deferred constraint trigger checks the final stored row, so an unfinished `pending` transfer cannot commit. The trigger reads the transfer's final row, not the original INSERT event's pending snapshot.
5. After successful COMMIT, the operation returns and the HTTP layer emits domain logs/counters and the response. All row/index locks are released at transaction end.

For simultaneous A→B and B→A with different keys, the unique index reservations are distinct and acquire no wallet locks. Both then attempt the smaller wallet UUID; only one proceeds to the larger. The waiter cannot hold a foreign-key `KEY SHARE` lock on the other wallet from the earlier insert, because those checks are deferred. This avoids the lock-upgrade cycle that would exist with immediate foreign keys. No application operation deletes wallets or changes their identities.

For identical keys, losers never acquire wallet locks: the unique insertion waits at step 1. After the winner commits, they receive SQLSTATE 23505 **for `transfers_idempotency_key_key`**, roll back, and query the stored transfer on their **same checked-out connection** with a fresh READ COMMITTED snapshot. A pool with one connection therefore still makes progress. Other uniqueness failures are not interpreted as replay. If the first transaction rolls back, a waiting insert can become the winner and perform the transfer.

## Replay and authorization

Replay first verifies ownership of the original source wallet, then compares canonical UUIDs and the exact integer amount. A valid changed request using an owned key returns 409, including when the new UUID does not identify an existing wallet. Invalid JSON, fractional/unsafe money or malformed UUIDs fail HTTP validation before any key lookup. A different caller cannot obtain the stored response by probing a key. GET transfer allows either participant; unrelated reads return 404. Identities and wallet ownership are immutable through this API.

Completed and insufficient-funds outcomes remain indefinitely in PostgreSQL; replay does not re-evaluate the current balance. Replenishing a declined source later does not change its earlier result. The destination-limit decline is equally durable. A new transfer needs a new key. Exactly once means **one committed money movement per key**, not guaranteed request delivery.

If the client loses the response after COMMIT, it retries the same identity, body and key and obtains the existing response. If the server loses its database connection during COMMIT, it cannot know whether COMMIT reached PostgreSQL; it returns an error or loses the response. The same retry resolves this ambiguity. It must not issue a new key for the same intended movement.

## Failure handling and operational limits

Failures before COMMIT roll back the debit, credit and pending key together. The connection is always released; failed rollback/unlock cleanup discards it rather than returning uncertain state to the pool. Both idle pool and checked-out client error events are handled, avoiding an unhandled EventEmitter error during disconnects. Tests kill actual PostgreSQL backends and force credit-time and commit-time database exceptions.

Pool size is 40, acquisition timeout 30s, statement timeout 30s, lock timeout 15s, and idle transaction timeout 30s. The configuration rejects values above 40: the free PostgreSQL plan permits 100 connections, and Render zero-downtime deploys temporarily overlap old and new instances, so two full pools consume at most 80 and preserve 20 connections of operational headroom. The acquisition deadline also bounds waiting for a busy pool. A live free-tier burst exposed the previous 5s deadline; increasing it lets the bounded pool drain contended work. Known acquisition, lock and statement timeouts return HTTP 503 `database_busy`. The service does not retry transactions internally. Callers may retry with the original request and key. More connections can move waiting from the application pool into PostgreSQL; they do not remove the wallet-row lock convoy. Contention trades latency and availability for strong money invariants. The burst runner deliberately reports HTTP failures rather than hiding them behind an automatic HTTP retry.

The migration runner holds a session advisory lock on one direct database connection, records each migration in the same transaction as its DDL, and releases/discards that connection on exit. This serializes overlapping deploy startups. Use a direct PostgreSQL endpoint for migrations, not a transaction-pooling endpoint. Add new migrations; do not rewrite applied migrations. Back up/validate any non-exercise database before schema changes.

## Deliberately rejected alternatives

Node read-then-write balance replacement loses concurrent updates. In-memory idempotency disappears on restart and cannot coordinate replicas. Unsorted wallet locks, or debit-first/credit-second without locking both rows, allow opposite-direction deadlocks. Immediate transfer foreign keys can acquire wallet locks before the documented sorted lock order. Serializable isolation can also be correct but needs serialization retries and adds no simplification here. Redis locks, distributed transactions and queues add components without improving this single-database invariant.

PostgreSQL is the source of truth. Observability is emitted after commit but is not an audit ledger: a process crash between COMMIT and logging can lose a log/counter increment. The stored transfer still persists and remains replayable. Direct administrator SQL can bypass business-level conservation; this exercise's runtime assumes trusted database administration and exposes no funding/edit/delete endpoint beyond first-create exercise seeding.

References: [PostgreSQL row locks](https://www.postgresql.org/docs/16/explicit-locking.html), [READ COMMITTED and concurrent INSERT](https://www.postgresql.org/docs/16/transaction-iso.html), [deferred constraints](https://www.postgresql.org/docs/16/sql-set-constraints.html), [node-postgres transactions](https://node-postgres.com/features/transactions).
