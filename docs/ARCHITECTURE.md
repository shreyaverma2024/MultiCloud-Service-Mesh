# Architecture

## 1. Design goals

The mesh demonstrates how independent data-plane sidecars can proxy all service
traffic across two cloud environments while a small control plane distributes
registration, routing, and configuration state.

The project intentionally keeps the component count small and explicit:

- exactly **5 application services**
- exactly **5 independent sidecar proxies**
- exactly **1 API Gateway**
- exactly **1 Control Plane**
- exactly **1 Cache API**
- exactly **1 Redis instance**
- exactly **2 logical PostgreSQL databases** on one PostgreSQL server
- exactly **1 Render Free web service** for the Render-side components

## 2. Cloud placement

### AWS Academy EC2

| Component | Container / process | Internal port | Published |
|---|---|---:|---|
| PostgreSQL 16 | `mesh-postgres` | 5432 | No |
| Redis 7 | `mesh-redis` | 6379 | No |
| Cache API | `mesh-cache-api` | 4100 | No |
| Control Plane | `mesh-control-plane` | 4000 | `127.0.0.1:4000` locally |
| Book Service | `mesh-book-service` | 4101 | No |
| Book Primary Sidecar | `mesh-book-primary-sidecar` | 5101 | No |
| Borrow Service | `mesh-borrow-service` | 4102 | No |
| Borrow Sidecar | `mesh-borrow-sidecar` | 5102 | No |
| Notification Service | `mesh-notification-service` | 4103 | No |
| Notification Sidecar | `mesh-notification-sidecar` | 5103 | No |
| API Gateway | `mesh-api-gateway` | 8080 | `8080` |
| Dashboard | `mesh-dashboard` | 3000 | `3000` |

### Render Free (one web service)

| Process | Internal port | Publicly reachable |
|---|---:|---|
| Book Replica Service | 4104 | No |
| Book Replica Sidecar | 5104 | No |
| Member Service | 4105 | No |
| Member Sidecar | 5105 | No |
| Render ingress dispatcher | `$PORT` (8081 locally) | Yes, one HTTPS endpoint |
| Process supervisor | 5300 (loopback) | No |

The four application/sidecar processes and the ingress dispatcher are independent
Node.js processes inside **one** container. The supervisor starts them, watches
their exit events, and restarts failed processes with exponential backoff. This is
**process-level isolation only**, not container-level isolation.

## 3. Request flow

### Normal client read

```
Client -> API Gateway :8080
       -> selected book sidecar (AWS :5101 or Render ingress /book-replica)
       -> selected book service (:4101 or :4104)
       -> Cache API :4100 -> Redis :6379 (cache hit)
          or PostgreSQL aws_library (cache miss / Redis unavailable)
       -> response travels back through the same sidecar and gateway
```

The gateway chooses the book target with a weighted random draw. The default policy
is **70% AWS / 30% Render**. `GET /api/books` and `GET /api/books/:id` use this
weighted path.

### Authoritative book reads and writes

`/cross-cloud/books` and non-read `/api/books` requests must reach the AWS primary.
They ignore the public weight and force the AWS target weight to 100. This prevents
a `0/100` public policy from accidentally disabling authoritative AWS access.

### Render replica read

```
Render book-replica-service
  -> API Gateway /cross-cloud/books (HMAC RENDER_TO_AWS_HMAC_SECRET)
  -> book-primary-sidecar -> book-service -> PostgreSQL
  -> replica caches the result through the Cache API
```

The replica never writes book data. It only reads authoritative data and caches it.

### Borrow flow

```
Client -> Gateway /api/borrows
       -> borrow-sidecar -> borrow-service
       -> member-sidecar on Render (HMAC AWS_TO_RENDER_HMAC_SECRET)
       -> book-primary-sidecar (AWS) for the authoritative book
       -> PostgreSQL transaction on aws_library
       -> notification-sidecar -> notification-service
       -> Cache API invalidation for the affected book
```

### Control and observability flow

- Every component registers with the Control Plane and sends a heartbeat every
  few seconds.
- The Control Plane marks a component `unknown`/`disconnected` when heartbeats are
  stale. It never reports a stale component as healthy.
- The API Gateway polls `/api/routing` and `/api/registry/services` every 2 seconds
  and keeps its last valid configuration if the Control Plane is unavailable.
- Components post real events (registration, health transitions, breaker changes,
  authentication failures, Redis failures, Render process crashes/restarts) to the
  Control Plane.
- The dashboard backend-for-frontend reads the Control Plane with a read token and
  exposes only sanitized JSON to the browser.

## 4. Data plane details

### Sidecars

Each sidecar is an Express reverse proxy created by `shared/sidecar-runtime.js`.
Each has its own process, port, upstream URL, health check, metrics registry,
circuit breaker, timeout, retry policy, and Control Plane registration.

A sidecar:

1. Receives a request.
2. Forwards it to its upstream service.
3. Retries retryable failures with a short delay.
4. Opens its circuit breaker after repeated failures.
5. Returns the upstream response or a structured `502`/`503`/`504` error.
6. Records request count, status classes, latency percentiles, retries, and
   breaker transitions.

### Gateway

The gateway adds `x-mesh-target`, `x-mesh-cloud`, `x-mesh-route`,
`x-mesh-attempts`, and `x-mesh-failover` response headers. These headers make
routing and failover observable in tests and in the dashboard.

It maintains a circuit breaker per target. A target is removed from selection when
its breaker is open and is re-admitted after a successful half-open probe.

### Failure behavior

| Failure | Behavior |
|---|---|
| One book target unhealthy | Traffic goes to the remaining healthy target |
| Selected target times out | Gateway retries the other book target (idempotent requests) |
| Repeated target failures | Per-target breaker opens for a cooldown period |
| All book targets fail | Structured `503`/`504` response; no fabricated data |
| Redis unavailable | Cache API returns `503`; services read PostgreSQL and report fallback |
| PostgreSQL unavailable | Control Plane continues in memory; data services return `503`/`503 NOT_READY` |
| Control Plane unavailable | Gateway and sidecars retain the last valid configuration |
| Render process crashes | Supervisor restarts it and records a real event |

## 5. Database design

One PostgreSQL server hosts two logical databases.

### `aws_library`

- `books`: authoritative book catalog and copy counts.
- `borrows`: borrowing records with foreign key to `books`.
- `mesh_events`: best-effort Control Plane event persistence.
- `mesh_routing_policy`: persisted 70/30 routing policy.

### `render_library`

- `members`: member records.
- `notifications`: notification history.

The Render Book Replica does **not** have a writable book database. The Member
Service uses `render_library`; in a real deployment it reaches that database over
TLS with a restricted firewall rule, as described in the deployment guide.

Both databases live on the same PostgreSQL server, so a PostgreSQL outage affects
both logical databases and the Control Plane's persistence. The Control Plane is
designed to keep running in memory during such an outage.

## 6. Redis and Cache API

There is exactly one Redis instance. No component connects to Redis directly except
the Cache API. The Cache API:

- requires `x-api-key: CACHE_API_KEY`
- supports get, set, delete, and namespace invalidation
- enforces TTL bounds
- records hits, misses, sets, deletes, invalidations, and Redis errors
- reports Redis health and hit ratio
- returns `503 CACHE_UNAVAILABLE` when Redis is down

Consumers treat cache failure as non-fatal and fall back to PostgreSQL.

## 7. Docker Compose profiles

| Profile | What starts | Intended use |
|---|---|---|
| `aws` | AWS-side services, sidecars, PostgreSQL, Redis, Cache API, Control Plane, Gateway, dashboard | AWS EC2 deployment |
| `split` | All five service/sidecar pairs in separate containers plus shared infrastructure | Full local development and testing |
| `bundle` | AWS-side components plus one `render-web` container with four supervised processes and the ingress | Local simulation of Render Free |

For AWS deployment, override `MEMBER_SIDECAR_URL` and `BOOK_REPLICA_URL` to the
Render public HTTPS paths before starting the `aws` profile. Because Render runs
outside the EC2 Docker network, `docker-compose.deploy.yml` adds one free Nginx TLS
proxy. Nginx is the only public entry point:

| Public port | Backend |
|---:|---|
| `8443` | API Gateway over HTTPS |
| `8444` | Control Plane over HTTPS |
| `8445` | Cache API over HTTPS |
| `5433` | PostgreSQL over TLS |

The gateway, dashboard, Control Plane, Cache API, PostgreSQL, Redis, services,
sidecars, and supervisor stay on loopback or the private Docker network. The
deployment override forces loopback binds for the management ports.

PostgreSQL TLS is enabled by the same override. PostgreSQL is never published on
`5432`; Nginx terminates client TLS on `5433` and opens a second verified TLS
connection to PostgreSQL. `pg_hba.conf` requires `hostssl` for every TCP
connection. The standalone `docker-compose.postgres-tls.yml` is kept for a
deployment that wants PostgreSQL TLS without the Nginx proxy.

The self-managed CA is generated by `deploy/tls/gen-certs.sh`. Its public
certificate is uploaded to Render as a Secret File; private keys stay on EC2.

## 8. Ports and exposure summary

- Public locally: `3000` dashboard, `8080` gateway, `127.0.0.1:4000` Control Plane,
  `127.0.0.1:8081` Render ingress in bundle mode.
- Never published locally: PostgreSQL `5432`, Redis `6379`, Cache API `4100`, all
  service ports `4101-4105`, all sidecar ports `5101-5105`, supervisor `5300`.
- Public on AWS EC2: only Nginx `8443`, `8444`, `8445`, and `5433`, plus SSH `22`
  restricted to the administrator.
- On Render, only the ingress port assigned by Render is public. The internal
  sidecar ports remain loopback-only.

## 9. Architectural constraints preserved

- Exactly five logical services and five independent sidecars.
- One API Gateway, one Control Plane, one Cache API, one Redis instance.
- Two logical PostgreSQL databases on one server.
- One Render Free web service with four supervised processes plus ingress.
- Normal application traffic always passes through a sidecar.
- Sidecars are independent from application-service logic.
- No claim that Render process separation equals container isolation.
