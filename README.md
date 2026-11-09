# Multi-Cloud Service Mesh - Data Plane Sidecar

A complete, locally runnable college-level project that demonstrates a multi-cloud
service mesh with **five application services**, **five independent sidecar proxies**,
a **Control Plane**, an **API Gateway**, an authenticated **Cache API** backed by
**one Redis instance**, **two logical PostgreSQL databases**, and a React monitoring
dashboard.

The mesh is designed for **AWS Academy EC2 + Render Free** and runs locally with
Docker Compose. It requires **zero personal spending** and does not use any paid
service.

> Status: local implementation and integration testing are complete. Deployment is
> intentionally left to the user; no GitHub, AWS, or Render account was accessed by
> the coding agent.

## Architecture at a glance

```
                         +-----------------------------+
   Browser / client ---> |  API Gateway (AWS) :8080    |
                         +--------------+--------------+
                                        |
                 +----------------------+-----------------------+
                 |                                              |
       AWS side (sidecars)                          Render side (ingress)
  book-primary-sidecar :5101                 /book-replica -> book-replica-sidecar
  borrow-sidecar       :5102                 /member       -> member-sidecar
  notification-sidecar :5103
                 |                                              |
  book-service :4101                              book-replica-service :4104
  borrow-service :4102                            member-service :4105
  notification-service :4103
                 |                                              |
                 +----------> Control Plane :4000 <-------------+
                              (registry, routing, events)
                 |
        Cache API :4100 ---> Redis :6379 (one instance)
                 |
        PostgreSQL :5432
          aws_library      (books, borrows, mesh policy/events)
          render_library   (members, notifications)
```

### Required logical counts

| Component | Count |
|---|---:|
| Application service instances | 5 |
| Independent sidecar proxies | 5 |
| PostgreSQL logical databases | 2 (one server) |
| Redis instances | 1 |
| API Gateway | 1 |
| Control Plane | 1 |
| Cache API | 1 |
| Render Free web services | 1 |

The Render Free service contains **one ingress dispatcher**, **four independent
supervised processes** (book replica service, book replica sidecar, member service,
member sidecar), and a **lightweight process supervisor**. This is process-level
isolation inside one container; it is **not** equivalent to separate-container
isolation. Locally and on AWS EC2, separate containers are used wherever practical.

## Implemented features

- Real HTTP reverse-proxy sidecars for all five services.
- Weighted book routing with an initial **70/30** AWS/Render split.
- Dynamic, validated weight updates through an authenticated Control Plane API.
- Health-aware endpoint removal and recovery.
- Retries with per-attempt HMAC signing, request timeouts, and circuit breakers.
- Cross-cloud HMAC-SHA256 request signing with nonce replay protection in both
  directions.
- One Redis instance accessed only through the authenticated Cache API.
- Cache hit/miss counters, TTLs, invalidation, and PostgreSQL fallback.
- Two logical PostgreSQL databases with schemas, seeds, backup, and restore scripts.
- Real heartbeats, metrics, events, alerts, and routing state in the Control Plane.
- React + Vite + Recharts dashboard with topology, traffic, performance, health,
  breaker, cache, event, alert, and Render process panels.
- Server-side dashboard proxy so browser code never receives Control Plane tokens.
- Render ingress dispatcher that keeps internal sidecar ports private.
- Render supervisor that detects and restarts crashed processes.
- Docker Compose profiles for local split mode, one-container bundle mode, and an
  AWS-only deployment.
- Unit tests and an integration suite that only records actually executed results.

## Technology stack

| Area | Technology |
|---|---|
| Backend | Node.js 20+, Express, JavaScript |
| Frontend | React, Vite, Recharts |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Containers | Docker, Docker Compose |
| Cross-cloud auth | HMAC-SHA256, nonces, timestamps |
| Tests | Jest, Node `assert`, real HTTP + Docker Compose actions |

## Repository layout

```
gateway/                 API Gateway, weighted routing, failover, breakers
control-plane/           Registry, routing policy, events, alerts, persistence
cache-api/               Authenticated Redis access layer
services/                Five application services
sidecars/                Five independent sidecar entrypoints
shared/                  Shared config, HTTP, HMAC, metrics, DB, cache, sidecar runtime
render/                  Render ingress dispatcher, supervisor, one-container image
dashboard/               React/Vite UI and server-side BFF
db/                      PostgreSQL init, schemas, seed data
scripts/                 Secret init, healthcheck, traffic, failure, backup, restore
tests/unit/              Jest unit tests
tests/integration/       End-to-end tests against the running stack
docs/                    Architecture, API, security, setup, deployment, troubleshooting
```

## Quick start on Windows

Prerequisites: **Docker Desktop** (with Docker Compose), **Node.js 20 or newer**,
and **npm**. No cloud account is needed for local use.

```cmd
cd C:\Users\Lenovo\Desktop\MultiCloud-Service-Mesh
npm install
npm run secrets
npm run stack:split
```

`npm run secrets` creates `.env` with fresh random secrets. It does **not** overwrite
an existing `.env`. Do not commit `.env`.

Open:

- Dashboard: <http://localhost:3000>
- API Gateway: <http://localhost:8080>
- Control Plane: <http://127.0.0.1:4000> (token-protected)
- Render ingress (bundle mode only): <http://127.0.0.1:8081> (HMAC-protected)

Useful commands:

```cmd
npm run test:unit
node tests\integration\run.js
npm run traffic
npm run failure stop book-service
npm run failure start book-service
npm run stack:down
```

For the one-container Render bundle locally:

```cmd
npm run stack:bundle
```

The dashboard can update weights only when the operator pastes the
`CONTROL_PLANE_ADMIN_TOKEN` value from `.env` into the weight-update field. The
token is kept in React state only and is never stored in the browser bundle.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Security model](docs/SECURITY.md)
- [Local setup and commands](docs/LOCAL_SETUP.md)
- [Testing and actual results](docs/TESTING.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [AWS Academy EC2 guide](docs/AWS_ACADEMY.md)
- [Render Free guide](docs/RENDER.md)
- [Manual GitHub instructions](docs/GITHUB.md)
- [Deployment order and checklist](docs/DEPLOYMENT.md)
- [Free-tier limits and zero-cost notes](docs/FREE_TIER_LIMITS.md)

## Zero-cost and security rules

- Only free and open-source software is used.
- No paid AWS service, paid Render plan, subscription, or payment card is required.
- No artificial keep-alive requests are used.
- Secrets are generated locally, stored only in `.env`, and never committed.
- `.env.example` contains placeholders only.
- PostgreSQL and Redis are never published on the host in the local stack.
- In cloud deployment, only one free Nginx TLS proxy is public on AWS; PostgreSQL
  `5432`, the gateway `8080`, the Control Plane `4000`, and the Cache API `4100`
  are not publicly reachable.
- PostgreSQL uses TLS with `hostssl` and verified certificates in cloud deployment.
- Render internal sidecar ports are not publicly exposed.
- Cross-cloud traffic is protected by application-level HMAC because Render's
  ordinary public HTTPS does **not** provide end-to-end sidecar mTLS.

## Known limitations

- Render Free sleeps after 15 minutes without inbound traffic and may take about a
  minute to wake.
- Render Free filesystems are ephemeral.
- Render Free has no private networking to AWS; cross-cloud calls use public HTTPS
  plus HMAC.
- Render Free uses shared regional outbound IP ranges, not a dedicated static IP.
  The ranges can be allowlisted but are shared with other Render customers.
- The local dashboard polls the Control Plane every few seconds; it is not a
  production-grade time-series monitoring system.
- PostgreSQL is self-managed. Cloud deployment uses a free self-managed CA and
  verified TLS; clients must be given `certs/ca.crt`.
- The self-managed server certificate must be regenerated if the EC2 public host
  or IP changes. Reusing the same CA avoids re-uploading it to Render.
- The Render one-container arrangement provides process supervision, not
  container-level isolation.

See [docs/FREE_TIER_LIMITS.md](docs/FREE_TIER_LIMITS.md) and
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for details.
