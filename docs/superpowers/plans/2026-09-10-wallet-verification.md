# Wallet verification and delivery plan

**Goal:** Complete the wallet exercise against the user's explicit acceptance criteria and retain reproducible evidence.

**Starting point:** Existing commit `7144e8f375a3c3e929bed4683ebadcf21c7014fe`, imported without rewriting its 14 commits from the clean local `paytm_project` checkout. Work takes place on `codex/wallet-verification` in the requested workspace. Both supplied attachments were read before implementation. The wallet Markdown is authoritative; the PDF agrees with it. Historical claims are not treated as verification from this session.

**Architecture:** Keep Express HTTP/auth/validation, wallet and transfer operations expressed through `pg`, and versioned SQL migrations. Retain PostgreSQL's global idempotency uniqueness, deferred wallet foreign keys, sorted row locks, conditional debit, and same-connection duplicate recovery. Add defenses and tests where observable behavior requires them; avoid a replacement architecture.

**Verification sequence (execute inline):**

- [ ] Establish baseline: `npm ci`, lint, typecheck, build, real PostgreSQL tests. Inspect existing Docker/Render resources without changing or deleting data.
- [ ] Harden API and DB invariants with regressions first: UUID canonicalization, exact BIGINT reads, input edge cases, missing wallets, ownership, durable replay after replenishment, small-pool retry storm, recipient overflow, database constraint and forced credit/commit failure rollback. Verify all connections are reusable after failures.
- [ ] Improve operations with regressions first: DB-backed health with source revision, bounded log fields, request/error/domain metrics and finite latency buckets, startup/shutdown and transaction timeouts, migration concurrency.
- [ ] Extend `scripts/burst.ts` and its integration tests: configurable 50 creates, 30 identical transfers, 300 bidirectional transfers, aggregate balance exhaustion; exact per-wallet deltas and row counts; HTTP/transport/retry counts and latency reported separately; timestamped success or failure files.
- [ ] Verify locked dependencies and Node LTS, production-only non-root multi-stage image, healthcheck, fresh Compose startup, isolated clean-checkout quality checks, and PostgreSQL-backed CI. Preserve the existing managed database major version and all existing records.
- [ ] Independent code review, fixes, and full validation. Commit incrementally using the existing Git identity; preserve original attribution.
- [ ] Publish reviewed source, deploy its image to the existing free Render service, verify revision and run a live burst, save sanitized logs/metrics and results. Use no paid resources. If account access or public repository visibility is blocked, finish independent work and record the exact remaining action.
- [ ] Rewrite README, the one-page write-up, and factual session record around actual checks, current provider terms, costs/limits, lock sequence, failure/retry behavior, and truthful AI disclosure.

**Design decisions:** Safe JSON numbers for inputs, decimal strings for all money responses. Exercise-only initial funding belongs solely to an insert; replay never changes it. Durable declines are HTTP 200 transfer results; malformed requests are machine-readable 4xx. The global key belongs to the source owner on replay; other participants can read transfer status. Keep the existing deferred-FK transaction design and explain uniqueness/FK locks explicitly.

**Acceptance:** No loss of attribution or existing data; no negative balances or conservation failures; identical durable replays and clean 409 conflicts; real local and live evidence distinguish HTTP failures, transport failures/retries, server latency, and end-to-end latency. Configuration alone is not evidence of deployment.
