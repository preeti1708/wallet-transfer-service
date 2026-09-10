# Verified delivery — September 10, 2026

The running API is [wallet-transfer-api.onrender.com](https://wallet-transfer-api.onrender.com), with [database-backed health](https://wallet-transfer-api.onrender.com/health), [sanitized public logs](https://wallet-transfer-api.onrender.com/logs), and [Prometheus metrics](https://wallet-transfer-api.onrender.com/metrics). The [repository is public](https://github.com/preeti1708/wallet-transfer-service). All times below are UTC.

**Deployed and verified source:** `95ca07197b578c0ed6ab57769ed98c02b9d76862`. Render built the Dockerfile and reported a successful deployment, ID `dep-dah99861egvs73d4otcg`, in 30.2 seconds. The server started at 11:30:03 and the public health response confirmed the exact source revision. Subsequent documentation/evidence commits do not change that deployed runtime.

## Executed results

| Check | Result / retained evidence |
| --- | --- |
| Real PostgreSQL integration suite | **55 tests passed in 11 files**, including injected failures, actual backend termination, migration upgrade preservation, and pool queue deadlines. |
| Fresh committed checkout | `npm ci`, lint, typecheck, tests and build passed under Node **24.21.0** with PostgreSQL **16.15**, using isolated Docker Compose resources. [Clean result](evidence/clean-20260910T112741Z/result.json), [quality output](evidence/clean-20260910T112741Z/quality.txt). |
| Production image | HEALTHCHECK passed; uid **1000**; development dependencies absent; source revision embedded. [Runtime](evidence/clean-20260910T112741Z/runtime.json). |
| Local Compose burst | **499/499 HTTP 200**, zero HTTP/transport/protocol failures or retries. [Burst](evidence/clean-20260910T112741Z/burst.json). |
| Local database checks | 6 wallets; **351 transfers: 275 completed, 76 declined**; **0 pending**; total **40025 paise**; minimum **1 paise**; all 3 migrations applied. [Database evidence](evidence/clean-20260910T112741Z/database-counts.json). |
| Public CI | [Run 34471521377](https://github.com/preeti1708/wallet-transfer-service/actions/runs/34471521377) **passed** at the exact deployed revision, including fresh-checkout Compose verification and artifact upload. [Retained CI result](evidence/ci-95ca071.json). |
| Live burst | 11:30:23–11:30:42, **499/499 HTTP 200**, zero HTTP/transport/protocol failures or retries. [Burst](evidence/live-20260910T113022Z/burst.json), [deployment metadata](evidence/live-20260910T113022Z/metadata.json), [health](evidence/live-20260910T113022Z/health.json). |
| Public log evidence | Bounded 200-entry snapshot includes created/debited/credited/declined/replay events, correlation IDs, and only the sanitized schema. [Snapshot](evidence/live-20260910T113022Z/public-logs.json), [checks](evidence/live-20260910T113022Z/logs-summary.json). |

Each default burst executed 50 simultaneous wallet creates (one wallet, balance 10000), 30 simultaneous identical transfers (one identical response), 300 transfers contending in opposite directions across three wallets (34 deliberate overdrafts, exact balances, total 30000 conserved), and 50 individually affordable 3-paise debits competing against 25 paise. The last phase produced exactly **8 completed / 42 declined**, balances **1 / 24**, then replayed every outcome without money movement. The 499 logical requests include reads, health, seed wallets and the 50 exhaustion replays. Identities and keys were fresh for each run; public evidence does not expose bearer identities.

Local tests check database row counts directly. Live checks use owned API reads and process-counter differences; no live database row-count query or production truncation is claimed. The managed database retains earlier exercise records.

## Latency and finite bucket coverage

| Measurement | Clean Compose | Live Render |
| --- | ---: | ---: |
| Whole burst duration | 1.438s | 18.794s |
| Client end-to-end p99, all 499 logical requests | 0.823s | **9.295s** |
| Client maximum | 0.832s | 9.335s |
| Server transfer histogram samples | 430 | 430 |
| Server transfer p99, interpolated histogram estimate | 0.979s | **7.351s** |
| All transfer samples below | 1s | 7.5s |
| Samples beyond largest finite 60s bucket | **0** | **0** |

Server latency includes application, pool and lock wait time, but excludes network and provider routing/cold-start time. Client latency includes network and any retry/backoff; these successful runs had no retries. The server and client rows cover different request populations and must not be compared as identical measurements. Server p99 is an estimate interpolated within cumulative histogram buckets, not an exact observed percentile or a measured PromQL time-series rate. Live measurements used before/after snapshots from one process with no counter reset. Initial live readiness took 908ms; this was a warm deployment, so **cold-start duration was not measured**.

The live metric difference recorded **351 newly created outcomes, 76 insufficient-funds declines and 79 idempotent replays**. [Before metrics](evidence/live-20260910T113022Z/metrics-before.prom), [after metrics](evidence/live-20260910T113022Z/metrics-after.prom), [summary](evidence/live-20260910T113022Z/metrics-summary.json). Reproduce the snapshot calculation with:

```bash
npx tsx scripts/summarize-metrics.ts AFTER.prom SUMMARY.json BEFORE.prom
```

The summary command exits nonzero if a tail exceeds finite buckets. Metrics and logs are process-local observations and can lose events after a commit followed by a process crash; PostgreSQL is the authority for balances and transfer outcomes.

## Failures retained and fixed

The original 27-test baseline passed in this session before expansion. Regression tests then exposed UUID casing, exact money overflow, logging, connection termination, outcome constraints and backward-compatible key handling; [SESSION.md](SESSION.md) records the fixes. A development-host burst observed 122 transport retries; it is not represented as a zero-failure run.

The first live run at `7e9b048` failed: 75 of 300 contended requests returned HTTP 500, with no transport failures/retries. Their mean server time was 5.021s, matching the pool acquisition timeout. 112/330 transfer samples exceeded the former five-second maximum bucket. [Failed burst](evidence/live-20260910T111816Z/burst.json), [failed-run histogram](evidence/live-20260910T111816Z/metrics-summary.json). A real PostgreSQL regression reproduced the five-second queue failure. The fix retains 20 clients, extends acquisition to 30s, returns sanitized 503 for known contention deadlines, and extends histogram buckets through 60s. The successful live rerun above verifies the fix.

[CI run 34470017591](https://github.com/preeti1708/wallet-transfer-service/actions/runs/34470017591) passed host quality checks but failed Compose verification with root-owned helper-container files preventing Linux cleanup. Helpers now run as the invoking uid/gid, use a temporary npm cache, and report cleanup failure accurately. The subsequent successful CI run verifies the complete Linux path. The earlier local 53-test clean check is retained separately in [its evidence directory](evidence/clean-20260910T110852Z/).

## Reproduce and limitations

```bash
npm ci
npm run burst -- https://wallet-transfer-api.onrender.com
# For the full isolated local checkout/image/database verification:
./scripts/verify-clean.sh
```

[README](../README.md) documents local startup, migrations, API/auth/seed semantics, burst options and PromQL. [CONCURRENCY.md](CONCURRENCY.md) explains the full uniqueness/foreign-key/row-lock sequence and failure recovery. The requested [one-page write-up](WRITEUP.md) is also available as a [one-page PDF](../output/pdf/wallet-transfer-writeup.pdf).

The existing Render account was checked on September 10, 2026: Hobby workspace, Free Docker API and Free managed PostgreSQL, **no card on file, $0 accrued**. No paid resources were enabled. The free API sleeps after 15 idle minutes; the workspace has 750 hours/month and showed 5 GB/month bandwidth. The 1 GB database **expires October 10, 2026** and has no free backups. Without payment details, exhausted quotas suspend service/builds. This deployment is time-limited exercise hosting; the observed successful burst is not a sustained-load SLA. [Official Render free-tier terms](https://render.com/docs/free).
