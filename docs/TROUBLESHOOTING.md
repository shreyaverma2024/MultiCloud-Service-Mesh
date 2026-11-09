# Troubleshooting

## 1. First checks

```cmd
docker compose --profile split ps
docker compose --profile split logs --tail=100 <service-name>
```

For bundle mode:

```cmd
docker compose --profile bundle ps
docker compose --profile bundle logs --tail=150 render-web
```

Check the health endpoints:

```cmd
curl http://localhost:8080/health
curl http://localhost:3000/health
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:8081/health
```

## 2. `.env` missing or incomplete

Symptom: containers exit immediately with a message about a required secret.

Fix:

```cmd
npm run secrets
```

The script creates `.env` and never overwrites an existing one. If `.env` exists but
is incomplete, compare it with `.env.example` and add the missing variables
manually. Do not paste secret values into documentation or chat.

## 3. Database authentication fails after regenerating secrets

PostgreSQL creates its users and passwords only on first initialization of the
volume. Regenerating `.env` while keeping the old volume causes authentication
failures.

Options:

1. Restore the previous `.env` values (preferred if you still have them).
2. Recreate the volume, which deletes local data:

```cmd
docker compose --profile split --profile bundle down -v
npm run secrets
npm run stack:split
```

Back up first with `npm run db:backup` if the data matters.

## 4. Port already in use

Symptoms: `bind: address already in use` for `3000`, `4000`, `8080`, or `8081`.

Find the process:

```powershell
Get-NetTCPConnection -LocalPort 8080 | Select-Object OwningProcess
Get-Process -Id <pid>
```

Stop the conflicting process or change the published port in `docker-compose.yml`.
Do not change internal service ports without also updating `.env` and the sidecar
upstream URLs.

## 5. A service is unhealthy but the container is running

Check its logs. Common causes:

| Cause | Evidence | Fix |
|---|---|---|
| Control Plane not ready | `ECONNREFUSED control-plane:4000` | Wait for Control Plane health, then restart the component |
| PostgreSQL not ready | `NOT_READY`, connection refused | Wait for PostgreSQL health; check credentials |
| Redis not ready | Cache API logs show reconnect attempts | Wait for Redis; verify `REDIS_PASSWORD` |
| Wrong upstream URL | Sidecar `proxy_failed` with a DNS error | Verify `*_SERVICE_URL` in compose or `.env` |
| Wrong advertise URL | Registry shows an unreachable address | Verify `*_SIDECAR_ADVERTISE_URL` |

## 6. Gateway returns `503` for all book reads

Possible causes:

1. Both book targets are unhealthy.
2. Both gateway circuit breakers are open after a destructive test.
3. The Control Plane routing policy has no routable targets.
4. Render sidecar is up but its upstream is down.

Check:

```cmd
curl http://localhost:8080/health
curl http://localhost:8080/metrics
```

Look at `routing.routableTargets` and the per-target breaker state. Breakers close
automatically after their cooldown and a successful probe. Wait 10-30 seconds and
retry. The integration suite does this explicitly after destructive tests.

## 7. Render bundle: `book-replica-sidecar` returns `502`/`504`

In bundle mode all Render processes share one container. Docker DNS names such as
`book-replica-service` do **not** resolve between processes inside the same
container. The supervisor must set loopback upstreams:

```text
BOOK_REPLICA_SERVICE_URL=http://127.0.0.1:4104
MEMBER_SERVICE_URL=http://127.0.0.1:4105
```

If these are missing, the sidecar tries a Docker DNS name and fails. Verify with:

```cmd
docker exec mesh-render-web printenv BOOK_REPLICA_SERVICE_URL
docker exec mesh-render-web printenv MEMBER_SERVICE_URL
```

Both should print `127.0.0.1` URLs. Rebuild `mesh-render-web:local` after changing
`render/supervisor.js`.

## 8. Render ingress returns `401`

The ingress requires a valid HMAC signature with `AWS_TO_RENDER_HMAC_SECRET`.

Check:

- The client id is allowed (`api-gateway` or `borrow-service` by default).
- The timestamp is within the allowed skew (default 5 minutes).
- The nonce has not been used before.
- The signature covers the exact method and path-and-query.
- The secret matches the Render service's environment.

A retry must re-sign the request with a fresh nonce. Reusing the previous headers
looks like a replay and is correctly rejected.

## 9. Render ingress returns `503`

Possible causes:

- The internal sidecar is not running.
- The sidecar's own circuit breaker is open after failures.
- The Render upstream service is not ready.

Check:

```cmd
curl http://127.0.0.1:8081/health
docker exec mesh-render-web node -e "fetch('http://127.0.0.1:5104/health').then(r=>r.text()).then(console.log)"
```

The sidecar health payload includes `upstream.healthy` and `circuitBreaker.state`.
If the breaker is `OPEN`, wait for `retryInMs` or restart the bundle container.

## 10. Supervisor does not restart a killed process

Check:

```cmd
curl http://127.0.0.1:8081/health
docker compose --profile bundle logs --tail=100 render-web
```

Expected: the process appears with `restarts` greater than zero and a
`process_restarted` event. If the whole container exited, the Docker restart policy
handles it instead; the supervisor only restarts child processes while it is alive.

## 11. Dashboard shows stale or disconnected data

The dashboard polls the Control Plane every few seconds. If the Control Plane is
down, the dashboard reports it as unreachable instead of showing fabricated data.

Check:

```cmd
curl http://127.0.0.1:4000/health
docker compose logs --tail=100 dashboard control-plane
```

## 12. Weight update fails

The weight update requires:

- `x-admin-token` equal to `CONTROL_PLANE_ADMIN_TOKEN`
- two integers from 0 to 100
- a sum of exactly 100

The dashboard never stores the token. Paste it into the operator field for each
update. A `401` means the token is missing or wrong; a `400` means the weights are
invalid.

## 13. Redis cache never hits

Check:

```cmd
curl http://localhost:8080/metrics
docker compose logs --tail=100 cache-api
```

Common causes:

- Redis is down and the Cache API returns `503`; services fall back to PostgreSQL.
- The cache key includes changing query parameters.
- The TTL is very short.
- Another test invalidated the namespace.

A miss followed by a PostgreSQL read is correct behavior, not an error.

## 14. Images are stale after a code change

Rebuild after changing `shared/`, `gateway/`, `services/`, `sidecars/`, or
`render/`:

```cmd
docker build -t mesh-node-app:local .
docker build -t mesh-render-web:local -f render/Dockerfile .
docker build -t mesh-dashboard:local -f dashboard/Dockerfile .
docker compose --profile split up -d
```

`npm run stack:split` and `npm run stack:bundle` rebuild automatically.

## 15. Windows line endings and scripts

The helper scripts are `.cmd` files. Run them from CMD or through `npm run`. In
PowerShell, `cmd /c scripts\start-split.cmd` also works.

## 16. Cloud TLS and PostgreSQL certificate errors

These problems only apply to the AWS EC2 deployment with
`docker-compose.deploy.yml`.

### `curl` reports a self-signed certificate error

Use the self-managed CA generated on EC2:

```bash
curl --cacert certs/ca.crt https://<aws-public-host>:8443/health
```

If the error says the certificate name does not match, the EC2 public host or IP
changed. Regenerate the server certificate with the same CA:

```bash
./deploy/tls/gen-certs.sh <new-public-host> <new-public-ip>
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws up -d --force-recreate postgres nginx
```

### `self-signed certificate in certificate chain` on Render

Upload `certs/ca.crt` as the Render Secret File `mesh-ca.crt`, then set:

```dotenv
DB_SSL_CA_PATH=/etc/secrets/mesh-ca.crt
NODE_EXTRA_CA_CERTS=/etc/secrets/mesh-ca.crt
DB_SSL_REJECT_UNAUTHORIZED=true
```

Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### PostgreSQL says `no pg_hba.conf entry ... SSL off`

PostgreSQL requires TLS. Set `DB_SSL=true` and the correct CA path. The deployment
`pg_hba.conf` uses `hostssl` for every TCP connection.

### PostgreSQL will not start after enabling TLS

Check that `certs/server.crt` and `certs/server.key` exist and that the
`db/tls-entrypoint.sh` wrapper is mounted. The wrapper copies the key to a
container-local path and fixes ownership for the `postgres` user. A bind-mounted
key owned by the EC2 login user is usually unreadable by PostgreSQL without this
step.

### Nginx returns `502`

Nginx is running, but the upstream container is unhealthy. Check:

```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws ps
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws logs --tail=100 nginx api-gateway control-plane cache-api postgres
```

### Nginx fails to start with `cannot load certificate`

Run `./deploy/tls/gen-certs.sh` first and confirm the `certs/` directory is
mounted read-only at `/etc/nginx/certs`.

## 17. Complete reset

```cmd
docker compose --profile split --profile bundle down --remove-orphans
docker compose --profile split --profile bundle down -v
npm run secrets
npm run stack:split
```

This deletes local database data. It does not affect any cloud resource.

## 17. Getting help without leaking secrets

When reporting a problem, include:

- the failing component name
- the HTTP status and error code
- relevant log lines with secret values removed
- the output of `docker compose ps`

Never include `.env`, database passwords, tokens, HMAC secrets, or private keys.
