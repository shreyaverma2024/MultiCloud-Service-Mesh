# Local Setup and Commands

## 1. Prerequisites

- Windows 10/11 (commands below use Windows CMD or PowerShell)
- Docker Desktop with Docker Compose v2
- Node.js 20 or newer
- npm 10 or newer
- A free TCP port on `3000`, `4000`, `8080`, and optionally `8081`

No cloud account, GitHub account, payment card, or paid service is needed for local
use.

## 2. First-time setup

Open a terminal in the project root:

```cmd
cd C:\Users\Lenovo\Desktop\MultiCloud-Service-Mesh
npm install
npm run secrets
```

`npm run secrets`:

- creates `.env` if it does not exist
- generates independent random secrets with Node.js `crypto`
- does not print the values
- does not overwrite an existing `.env`

If you ever need to regenerate secrets, you must also recreate the PostgreSQL
volume, because the database users and passwords are created on first initialization:

```cmd
docker compose --profile split --profile bundle down -v
npm run secrets
```

This deletes local database data. Do not run it casually.

## 3. Start the full local stack (separate containers)

```cmd
npm run stack:split
```

This uses the `split` profile and starts:

- PostgreSQL and Redis
- Control Plane and Cache API
- all five application services
- all five independent sidecars
- API Gateway
- dashboard

Wait until all containers report healthy:

```cmd
docker compose --profile split ps
```

URLs:

| Service | URL |
|---|---|
| Dashboard | <http://localhost:3000> |
| API Gateway | <http://localhost:8080> |
| Control Plane | <http://127.0.0.1:4000> |
| Gateway health | <http://localhost:8080/health> |
| Dashboard health | <http://localhost:3000/health> |

## 4. Start the one-container Render bundle locally

```cmd
npm run stack:bundle
```

This starts the AWS-side components plus one `render-web` container that runs:

1. Book Replica Service
2. Book Replica Sidecar
3. Member Service
4. Member Sidecar
5. Render ingress dispatcher
6. Process supervisor

The ingress is published at <http://127.0.0.1:8081> and requires HMAC signatures.

The bundle demonstrates Render's process-level arrangement. It is **not** equivalent
to separate-container isolation.

## 5. Stop the stack

```cmd
npm run stack:down
```

The PostgreSQL volume is preserved. To delete all local database data as well:

```cmd
docker compose --profile split --profile bundle down -v
```

## 6. Environment configuration

All runtime configuration lives in `.env`. The tracked template is `.env.example`
and contains placeholders only.

Important groups:

- PostgreSQL: `POSTGRES_*`, `AWS_DB_*`, `RENDER_DB_*`, `DB_SSL`
- Redis and Cache API: `REDIS_*`, `CACHE_API_*`
- Control Plane: `CONTROL_PLANE_*`, `HEARTBEAT_INTERVAL_MS`, `COMPONENT_STALE_MS`
- Cross-cloud HMAC: `AWS_TO_RENDER_HMAC_SECRET`, `RENDER_TO_AWS_HMAC_SECRET`
- Gateway and sidecars: timeouts, retries, breaker thresholds
- Render bundle: `RENDER_*`
- Dashboard: `DASHBOARD_PORT`, `DASHBOARD_POLL_INTERVAL_MS`

See `.env.example` for the complete list.

Never commit `.env`. It is ignored by `.gitignore` and excluded by `.dockerignore`.

## 7. Dashboard weight updates

1. Open <http://localhost:3000>.
2. Find the traffic panel.
3. Paste the value of `CONTROL_PLANE_ADMIN_TOKEN` from `.env` into the admin-token
   field.
4. Set AWS and Render weights that total exactly 100.
5. Submit.

The token is kept in React state only and is not stored in the browser. The
dashboard BFF forwards it to the Control Plane as `x-admin-token`.

## 8. Generate real traffic

```cmd
npm run traffic
```

Defaults: 30 seconds, concurrency 5, 50 ms delay. Override with environment
variables:

```cmd
set DURATION_SECONDS=60
set CONCURRENCY=10
set DELAY_MS=10
npm run traffic
```

PowerShell:

```powershell
$env:DURATION_SECONDS='60'
$env:CONCURRENCY='10'
$env:DELAY_MS='10'
npm run traffic
```

The summary is calculated only from real HTTP responses and includes status codes,
targets, clouds, and latency percentiles.

## 9. Simulate failures

```cmd
npm run failure stop book-service
npm run failure start book-service
npm run failure pause book-primary-sidecar
npm run failure unpause book-primary-sidecar
npm run failure redis-down
npm run failure redis-up
npm run failure db-down
npm run failure db-up
npm run failure cp-down
npm run failure cp-up
```

In bundle mode, kill one supervised process:

```cmd
npm run render:kill member-service
```

Or use the failure helper:

```cmd
npm run failure kill-render-process member-service
```

The supervisor should restart it and record a real crash/restart event.

## 10. Database backup and restore

Back up both logical databases:

```cmd
npm run db:backup
```

Files are written to `backups/` and are git-ignored. They may contain application
data, so keep them private.

Restore one backup:

```cmd
node scripts\db-restore.js backups\aws_library-<timestamp>.sql --database aws_library --yes
```

The `--yes` flag is required because restore overwrites objects in the target
database. The script refuses paths outside `backups/`.

For a safe restore test, restore into a temporary database first:

```cmd
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE mesh_restore_test;"
node scripts\db-restore.js backups\aws_library-<timestamp>.sql --database mesh_restore_test --yes
docker compose exec -T postgres psql -U postgres -d mesh_restore_test -c "SELECT count(*) FROM books;"
docker compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE mesh_restore_test;"
```

## 11. Health and logs

```cmd
docker compose --profile split ps
docker compose --profile split logs -f api-gateway
docker compose --profile split logs -f book-primary-sidecar
docker compose --profile bundle logs -f render-web
```

Useful endpoints:

```cmd
curl http://localhost:8080/health
curl http://localhost:8080/metrics
curl http://localhost:3000/health
curl http://127.0.0.1:4000/health
```

The Control Plane and dashboard endpoints are token-protected where required.

## 12. Tests

```cmd
npm run test:unit
node tests\integration\run.js
```

Or run both through:

```cmd
scripts\test.cmd
```

The integration runner expects a running stack and uses real Docker Compose actions
for destructive tests. Use `--safe` to skip destructive tests:

```cmd
node tests\integration\run.js --safe
```

See [TESTING.md](TESTING.md) for the full acceptance matrix and actual results.

## 13. AWS-only profile

For an AWS EC2 deployment, the `aws` profile starts only AWS-side components.
Render runs outside the EC2 Docker network, so the deployment override adds one
free Nginx TLS proxy and enables PostgreSQL TLS:

```bash
./deploy/tls/gen-certs.sh <aws-public-dns> <aws-public-ip>
docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile aws up -d --build
```

Nginx is the only public entry point:

- `8443` -> API Gateway over HTTPS
- `8444` -> Control Plane over HTTPS
- `8445` -> Cache API over HTTPS
- `5433` -> PostgreSQL over TLS

The gateway, dashboard, Control Plane, Cache API, PostgreSQL, Redis, application
services, and sidecars stay on loopback or the private Docker network. Restrict the
Nginx ports in the EC2 security group. See [AWS_ACADEMY.md](AWS_ACADEMY.md),
[DEPLOYMENT.md](DEPLOYMENT.md), and [SECURITY.md](SECURITY.md).

## 14. Clean restart checklist

If a container is unhealthy:

1. Check `docker compose --profile <profile> ps`.
2. Check logs for the unhealthy container.
3. Verify `.env` exists and is complete.
4. Verify PostgreSQL and Redis are healthy.
5. If database credentials changed, recreate the PostgreSQL volume.
6. Rebuild the image after changing `shared/`, `gateway/`, `services/`, `sidecars/`,
   or `render/`:

```cmd
docker build -t mesh-node-app:local .
docker compose --profile split up -d
```

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for more.
