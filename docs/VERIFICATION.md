# Verification evidence

This record distinguishes executed checks from configuration. The original repository's 14 commits are retained; their historical verification claims are not counted as results from this session.

## Executed before container/deployment verification

- September 10, 2026: original 27-test PostgreSQL baseline, `npm ci`, lint, typecheck, build passed.
- Expanded suite: 52 tests passed, then a historical-schema migration regression was added and executed separately. Tests run against actual PostgreSQL 16.15 in an isolated Docker container, not a mocked database.
- Covered: 50 wallet creates; 30 same-key transfers; 300 bidirectional contended transfers; 50 competing affordable debits (8 completed, 42 declined); exact BIGINT reads; missing/unauthorized resources; changed-body conflict; durable decline after replenishment; one-connection pool; rollback after forced credit and COMMIT errors; real backend termination; lost HTTP response after a real COMMIT; interrupted HTTP-503 accounting; legacy keys.
- Local HTTP transport resets were observed and retried. They are not described as zero failures. The burst report records their counts and the retry-preserved request contract.
- Registry installation/audit, lint, typecheck and build passed for compatible pinned dependencies, with Node 24 selected for the image/CI.
- Render dashboard: existing API and PostgreSQL are Free; Hobby account, no card on file, $0 accrued; database expires October 10, 2026. This confirms account terms, not deployment of these new changes.

Fresh-checkout, image, CI and deployed-source results will be recorded below after execution. See `docs/evidence/` for timestamped machine-readable artifacts and `docs/SESSION.md` for failures and fixes.
