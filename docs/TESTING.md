# Testing and Actual Results

This document records **only tests that were actually executed** against the local
Docker Compose stack. No metrics, results, or passes are fabricated.

## 1. How to run

```cmd
npm run test:unit
node tests\integration\run.js
```

With a running stack. The integration runner supports:

```cmd
node tests\integration\run.js --safe
```

`--safe` skips destructive tests (pausing upstreams, stopping PostgreSQL, killing a
Render process, changing weights). The default full mode performs real Docker
Compose actions and real HTTP requests.

Test reports are written to `tests/integration/reports/last-run.json`. That folder
is git-ignored because it is a local runtime artifact.

## 2. Unit tests

Command:

```cmd
npm run test:unit
```

Result on the final run (2026-11-09): **34 passed, 0 failed** (Jest, `--runInBand`).

The unit suite covers shared helpers such as configuration parsing, validation,
response envelopes, metrics snapshots, HMAC canonicalization/signature/replay
handling, circuit-breaker transitions, and load-env behavior.

## 3. Integration test inventory

The integration suite runs real HTTP requests through the gateway and real Docker
Compose actions for failure scenarios.

| # | Test | What it proves |
|---:|---|---|
| 1 | Stack health endpoints | Gateway, dashboard, Control Plane, and ingress respond |
| 2 | All expected components registered | Registry contains all five services, five sidecars, gateway, Cache API, Control Plane |
| 3 | All five service/sidecar pairs proxy real traffic | Every pair serves a real request through its sidecar |
| 4 | Weighted 70/30 book routing | Both AWS and Render book targets receive traffic |
| 5 | Dynamic weight update takes effect | A validated admin weight update changes routing |
| 6 | Redis cache hit and PostgreSQL fallback | Real cache hit/miss and behavior with Redis stopped |
| 7 | Timeout handling under a paused upstream | A paused upstream produces a structured timeout/failover, not a hang |
| 8 | Circuit breaker and health-aware failover | Repeated failure opens a breaker and traffic fails over, then recovers |
| 9 | Cross-cloud HMAC enforcement | Unsigned, tampered, stale, and replayed requests are rejected; signed requests work |
| 10 | Dashboard reflects real request metrics | Dashboard BFF exposes real Control Plane state |
| 11 | Events and alerts endpoints | Real events/alerts are readable with a read token |
| 12 | Control Plane survives a PostgreSQL outage | Control Plane keeps serving in memory and recovers |
| 13 | Render supervisor restarts a crashed process | A killed supervised process is restarted (bundle mode only) |
| 14 | Secrets are not exposed to the browser | Dashboard HTML/JS contain no configured secret values |
| 15 | Unauthorized access is rejected | Management endpoints require correct tokens |
| 16 | Internal ports are not published on the host | PostgreSQL, Redis, Cache API, services, sidecars are not host-reachable |
| 17 | Final mesh health | Mesh returns to a healthy state after destructive tests |

## 4. Split mode result

Profile: `split` (all five service/sidecar pairs in separate containers).

Latest executed result (2026-11-09): **16 passed, 0 failed, 1 skipped**.

The first run after the deployment-readiness changes reported two failures
(circuit-breaker failover reporting and a subsequent cross-cloud HMAC `503`).
The gateway now reports `x-mesh-failover` on the final failure response whenever
more than one target was attempted; the integration assertions were not weakened.
The full suite was rerun after rebuilding the gateway and passed as shown above.

The skipped test is `Render supervisor restarts a crashed process`, which applies
only to `bundle` mode because split mode does not run the supervisor.

## 5. Bundle mode result

Profile: `bundle` (one `render-web` container with four supervised processes plus
the ingress dispatcher).

Latest executed result: **17 passed, 0 failed, 0 skipped**.

This includes the supervisor restart test. The ingress routes are HMAC-protected,
and the internal sidecars bind to loopback inside the container.

## 6. Traffic generation

Command actually executed:

```powershell
$env:DURATION_SECONDS='12'
$env:CONCURRENCY='4'
$env:DELAY_MS='20'
node scripts/generate-traffic.js
```

Actual final summary:

| Metric | Value |
|---|---:|
| Duration | 12 s |
| Concurrency | 4 |
| Total requests | 902 |
| Successful (`200`/`201`) | 887 |
| `409` conflicts | 15 |
| Error rate | 1.66% |

The `409` responses are expected business conflicts from concurrent borrow requests
for the same limited-copy book; they are counted as non-2xx but are not mesh errors.

Target distribution observed during the run:

| Target | Requests |
|---|---:|
| `book-primary-sidecar` | ~68% of book reads |
| `book-replica-sidecar` | ~32% of book reads |
| `borrow-sidecar` | real borrow traffic |
| `member-sidecar` | real member lookups |

Latency observed: average about 29 ms, p50 about 22 ms, p95 about 84 ms, max about
212 ms during the run. These are local-machine numbers, not cloud benchmarks.

## 7. Database backup and restore verification

Commands actually executed:

```cmd
npm run db:backup
```

Result: both `aws_library` and `render_library` were dumped successfully.

Restore was verified safely into temporary databases, not over the live databases:

```cmd
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE mesh_restore_test_aws;"
node scripts\db-restore.js backups\aws_library-<timestamp>.sql --database mesh_restore_test_aws --yes
```

Row counts matched exactly:

| Database | Table | Live | Restored |
|---|---|---:|---:|
| `aws_library` | `books` | 12 | 12 |
| `aws_library` | `borrows` | 35 | 35 |
| `aws_library` | `mesh_events` | 741 | 741 |
| `aws_library` | `mesh_routing_policy` | 1 | 1 |
| `render_library` | `members` | 5 | 5 |
| `render_library` | `notifications` | 37 | 37 |

The temporary databases were dropped afterwards. The live databases were not
overwritten.

## 8. Security checks

Executed checks and actual results:

- Integration security tests passed (HMAC, tokens, replay, port exposure, browser
  secret scan).
- A repository scan searched all configured secret values across source, config, and
  documentation files, excluding `.env`, `node_modules`, backups, and binary files.
  Result: **no secret value found outside `.env`**.
- `.env.example` contains only `__GENERATE__` placeholders.
- `.gitignore` excludes `.env`, backups, certificates, keys, and runtime reports.
- `.dockerignore` excludes `.env`, certificates, keys, tests, and docs from images.

## 9. Failure scenarios exercised

| Scenario | How | Observed behavior |
|---|---|---|
| Paused upstream | Pause a sidecar/service container | Gateway returns a structured timeout/failover; no hang |
| Repeated target failure | Stop a book target | Breaker opens; traffic moves to the other target |
| Redis down | Stop Redis | Cache API returns `503`; services fall back to PostgreSQL |
| PostgreSQL down | Stop PostgreSQL | Control Plane serves from memory; data services return `503 NOT_READY` |
| Control Plane down | Stop Control Plane | Gateway/sidecars keep last valid config; health reports unreachable |
| Render process crash | Kill a supervised process | Supervisor restarts it and records an event |

## 10. What was not tested

- Real AWS Academy EC2 deployment.
- Real Render Free deployment.
- Real cross-cloud latency and network partitions.
- Render sleep/wake behavior over 15+ minutes.
- Multi-replica nonce-store behavior (the project runs one gateway and one ingress).
- TLS termination and PostgreSQL TLS were validated at the configuration level
  (`nginx -t`, certificate generation and SAN checks, Compose validation), but a live
  HTTPS/PostgreSQL-TLS deployment was not performed locally.

These are deployment-time checks and are intentionally left to the user.

## 11. Honest status

The local implementation, unit tests, split-mode integration, bundle-mode
integration, traffic generation, backup/restore verification, and security checks
were executed successfully on the dates recorded in the session notes.

Cloud deployment was **not** performed by the coding agent. No GitHub, AWS, or
Render account was accessed, and no code was committed or pushed.
