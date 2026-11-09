# Deployment Order and Checklist

This is the manual deployment runbook for the approved architecture. The coding
agent does not deploy anything.

## 1. Deployment order

1. Verify the project locally in `split` and `bundle` modes.
2. Push the reviewed project to your own GitHub repository.
3. Deploy the AWS-side stack on AWS Academy EC2.
4. Generate the free self-managed TLS certificates and start Nginx.
5. Deploy the Render-side container on Render Free.
6. Upload the AWS CA certificate to Render as a Secret File.
7. Connect the two sides with public URLs and shared secrets.
8. Run cross-cloud smoke tests over HTTPS.
9. Record results and take a database backup.

Render is deployed after AWS because the Render environment needs the AWS public
HTTPS URLs, the CA certificate, and the shared secrets.

## 2. Environment matrix

Prerequisites: Docker Engine, the Docker Compose v2 plugin (v2.24.4 or newer for
the `!override` tag used by `docker-compose.deploy.yml`), OpenSSL, and Node.js for
secret generation.

| Variable | AWS | Render | Notes |
|---|---|---|---|
| `MESH_MODE` | `split` | `bundle` | Selects the deployment arrangement |
| `POSTGRES_HOST` | `postgres` (Docker) | AWS public host | Render connects through Nginx |
| `POSTGRES_PORT` | `5432` (private) | `5433` (public TLS) | Never publish 5432 |
| `DB_SSL` | `true` | `true` | TLS on every TCP connection |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | `true` | Do not disable verification |
| `DB_SSL_CA_PATH` | `/etc/mesh-certs/ca.crt` | `/etc/secrets/mesh-ca.crt` | Public CA certificate |
| `MESH_REQUIRE_DB_TLS` | `true` | n/a | PostgreSQL `hostssl` rules |
| `AWS_GATEWAY_URL` | internal or public | `https://<aws-host>:8443` | Render -> AWS calls |
| `CONTROL_PLANE_URL` | `http://control-plane:4000` | `https://<aws-host>:8444` | Render registration |
| `CACHE_API_URL` | `http://cache-api:4100` | `https://<aws-host>:8445` | Render cache access |
| `MEMBER_SIDECAR_URL` | `https://<render-service>.onrender.com/member` | n/a | AWS -> Render |
| `BOOK_REPLICA_URL` | `https://<render-service>.onrender.com/book-replica` | n/a | AWS -> Render |
| `RENDER_PUBLIC_BASE_URL` | n/a | `https://<render-service>.onrender.com` | Advertised sidecar URLs |
| `NODE_EXTRA_CA_CERTS` | n/a | `/etc/secrets/mesh-ca.crt` | Outbound HTTPS trust |
| `AWS_TO_RENDER_HMAC_SECRET` | same | same | Must match |
| `RENDER_TO_AWS_HMAC_SECRET` | same | same | Must match |
| `CONTROL_PLANE_*_TOKEN` | same | same | Must match |
| `CACHE_API_KEY` | same | same | Must match |
| Database passwords | same | same | Must match the database users |

Use fresh cloud secrets. Do not reuse local development secrets.

The public AWS protocol is HTTPS on `8443`, `8444`, and `8445`. Do not configure
Render with `http://` URLs or with the old `8080`, `4000`, or `4100` public ports;
those ports are not exposed in the deployment.

## 3. AWS EC2 checklist

- [ ] Instance started in the lab
- [ ] Docker, Compose, and OpenSSL installed
- [ ] Repository cloned
- [ ] `.env` created with cloud secrets
- [ ] `MESH_MODE=split`
- [ ] `POSTGRES_HOST=postgres`, `POSTGRES_PORT=5432`
- [ ] `DB_SSL=true`, `DB_SSL_REJECT_UNAUTHORIZED=true`
- [ ] `DB_SSL_CA_PATH=/etc/mesh-certs/ca.crt`
- [ ] `MESH_REQUIRE_DB_TLS=true`
- [ ] `MEMBER_SIDECAR_URL` and `BOOK_REPLICA_URL` set to Render HTTPS
- [ ] `./deploy/tls/gen-certs.sh <aws-public-dns> <aws-public-ip>` run
- [ ] `certs/ca.crt` copied to Render as a Secret File
- [ ] Security group allows only 22, 8443, 8444, 8445, and 5433
- [ ] `docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile aws up -d --build` succeeds
- [ ] `mesh-tls-proxy` healthy
- [ ] PostgreSQL and Redis healthy
- [ ] Control Plane, Cache API, gateway, dashboard healthy
- [ ] Five AWS-side service/sidecar components healthy
- [ ] Gateway reachable from the internet over HTTPS with `certs/ca.crt`
- [ ] PostgreSQL reachable on 5433 with `sslmode=verify-full`
- [ ] Dashboard reachable through an SSH tunnel, not a public port

## 4. Render checklist

- [ ] Docker web service created from `render/Dockerfile`
- [ ] Free instance type selected
- [ ] `mesh-ca.crt` Secret File uploaded from `certs/ca.crt`
- [ ] `DB_SSL=true`, `DB_SSL_REJECT_UNAUTHORIZED=true`
- [ ] `DB_SSL_CA_PATH=/etc/secrets/mesh-ca.crt`
- [ ] `NODE_EXTRA_CA_CERTS=/etc/secrets/mesh-ca.crt`
- [ ] AWS URLs use `https://<aws-host>:8443`, `:8444`, and `:8445`
- [ ] `POSTGRES_PORT=5433`
- [ ] All other environment variables set
- [ ] `PORT` left to Render
- [ ] Health check path `/health`
- [ ] Deploy succeeds
- [ ] Five processes running
- [ ] `/health` returns healthy
- [ ] Supervisor status protected by `RENDER_SUPERVISOR_TOKEN`

## 5. Cross-cloud checklist

- [ ] AWS `MEMBER_SIDECAR_URL` points to Render `/member` over HTTPS
- [ ] AWS `BOOK_REPLICA_URL` points to Render `/book-replica` over HTTPS
- [ ] Render `AWS_GATEWAY_URL` points to `https://<aws-host>:8443`
- [ ] Render `CONTROL_PLANE_URL` points to `https://<aws-host>:8444`
- [ ] Render `CACHE_API_URL` points to `https://<aws-host>:8445`
- [ ] Render trusts `certs/ca.crt` through its Secret File
- [ ] HMAC secrets match in both directions
- [ ] Signed AWS -> Render member request succeeds
- [ ] Signed Render -> AWS book request succeeds
- [ ] Unsigned requests are rejected
- [ ] Replayed requests are rejected
- [ ] Render components appear in the registry
- [ ] Weighted 70/30 book routing is visible in response headers
- [ ] PostgreSQL TLS verification succeeds with `sslmode=verify-full`

## 6. Smoke tests

### AWS side (from the EC2 instance)

```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/metrics
curl -s http://localhost:3000/health
curl -s http://localhost:4000/health
curl -s --cacert certs/ca.crt https://localhost:8443/health
curl -s --cacert certs/ca.crt https://localhost:8444/health
curl -s --cacert certs/ca.crt https://localhost:8445/health
```

### From the internet

Copy `certs/ca.crt` to your laptop over a secure channel, then:

```bash
curl -s --cacert ca.crt https://<aws-public-host>:8443/health
curl -s https://<render-service>.onrender.com/health
```

### PostgreSQL TLS

```bash
PGPASSWORD='<render_app password>' psql \
  "host=<aws-public-host> port=5433 dbname=render_library user=render_app \
   sslmode=verify-full sslrootcert=ca.crt" \
  -c 'SELECT 1;'
```

Expected: `1`. A certificate error means the SAN or CA file does not match the
host you used. Do not work around it by disabling verification.

### Weighted routing

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -D - \
    --cacert ca.crt "https://<aws-public-host>:8443/api/books?limit=1" \
    | grep -i x-mesh-cloud
done
```

### Render member route

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  --cacert ca.crt "https://<aws-public-host>:8443/api/members?limit=1"
```

Expected `200`. A `503` means the Render side is down or the gateway cannot reach it.

### Signed Render -> AWS request

Use a small script with `shared/hmac.js` and the deployment
`RENDER_TO_AWS_HMAC_SECRET`. Do not print the secret. A correct request returns
`200`; an unsigned request returns `401`.

## 7. Post-deploy operations

### Update weights

```bash
curl -X PUT "https://<aws-public-host>:8444/api/routing/book/weights" \
  --cacert ca.crt \
  -H "x-admin-token: <CONTROL_PLANE_ADMIN_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"aws":70,"render":30}'
```

Both values must be integers and sum to exactly 100.

### Backup

```bash
npm run db:backup
```

Copy backups off the instance if the lab may reset.

### Restart after a code change

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws up -d --build
```

On Render, trigger a manual deploy or push to the connected branch.

### Certificate renewal or public IP change

Reuse the existing CA and regenerate only the server certificate:

```bash
./deploy/tls/gen-certs.sh <new-public-dns> <new-public-ip>
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws up -d --force-recreate postgres nginx
```

Render does not need a new secret file unless you used `NEW_CA=1`.

## 8. Rollback

### AWS

```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws down
git checkout <previous-commit>
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws up -d --build
```

The PostgreSQL volume is preserved unless you explicitly use `down -v`. Keep
`certs/` on the host; it is git-ignored and is not removed by a code rollback.

### Render

Use the Render dashboard to redeploy a previous commit, or revert the Git commit and
push. Environment variables and Secret Files remain until changed.

### Routing

If a new weight policy causes problems, restore 70/30 through the Control Plane API.
Authoritative AWS routes are unaffected because they ignore public weights.

## 9. Security gates

Do not consider the deployment complete unless:

- [ ] `.env` is not in Git
- [ ] `.env.example` contains only placeholders
- [ ] Redis is not publicly reachable
- [ ] PostgreSQL `5432` is not publicly reachable
- [ ] Gateway `8080`, Control Plane `4000`, and Cache API `4100` are not publicly reachable
- [ ] Only Nginx `8443`, `8444`, `8445`, and `5433` are public
- [ ] Internal service/sidecar ports are not publicly reachable
- [ ] HMAC is enabled in both directions
- [ ] Unsigned and replayed requests are rejected
- [ ] Control Plane admin token is not exposed to browsers
- [ ] PostgreSQL uses TLS with `hostssl` and `DB_SSL_REJECT_UNAUTHORIZED=true`
- [ ] Render has the CA Secret File and `NODE_EXTRA_CA_CERTS` set
- [ ] `certs/ca.key` and `certs/server.key` are not in Git or Render
- [ ] You accept the documented Render process-isolation limitation

## 10. Known deployment risks

| Risk | Impact | Mitigation |
|---|---|---|
| Render Free sleeps | Cold-start failures | Failover to AWS; wake before demos |
| Render ephemeral disk | Data loss on redeploy | Store data in PostgreSQL/Redis |
| Render shared outbound ranges | Cannot uniquely identify Render by IP | TLS, HMAC, strong tokens, least-privilege DB user |
| AWS public IP changes | Certificate SAN and Render URLs become stale | Regenerate server cert with the same CA; update URLs |
| Self-managed CA | Clients must be given `ca.crt` | Render Secret File; `--cacert` for manual tests |
| Nginx single point of failure | Public AWS endpoints unavailable | Restart the container; keep the stack simple |
| AWS Academy session limits | Instance stops | Restart the lab and instance |
| No end-to-end mTLS | Traffic is authenticated, not mutually authenticated | HMAC plus TLS; document limitation |
| Single PostgreSQL server | One outage affects both logical databases | Control Plane memory fallback; backups |
| Single Redis instance | Cache outage | Services fall back to PostgreSQL |

## 11. Definition of done

- Local split and bundle tests pass.
- AWS and Render deployments are healthy.
- Only the Nginx TLS ports are public on AWS.
- PostgreSQL TLS verification succeeds with `sslmode=verify-full`.
- Cross-cloud signed traffic works in both directions over HTTPS.
- Unsigned and replayed traffic is rejected.
- Dashboard shows real registry, routing, traffic, cache, event, and alert data.
- Backup and restore have been verified.
- Known limitations are documented honestly.
- No paid resource was created and no payment details were entered.
