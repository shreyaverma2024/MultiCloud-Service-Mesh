# Render Free Deployment Guide

This guide prepares the Render-side deployment **for you to execute manually**. The
coding agent did not log in to Render or deploy anything.

## 1. What runs on Render

Exactly **one Render Free web service** runs the `render/Dockerfile` image. Inside
that one container the supervisor starts four independent processes plus the
ingress dispatcher:

1. Book Replica Service (`4104`, loopback only)
2. Book Replica Sidecar (`5104`, loopback only)
3. Member Service (`4105`, loopback only)
4. Member Sidecar (`5105`, loopback only)
5. Render ingress dispatcher (`$PORT`, public)
6. Process supervisor (`5300`, loopback only)

This is **process-level isolation only**. It is not equivalent to separate
containers, and the documentation does not claim otherwise.

## 2. Prerequisites

- A Render account (free, no payment card required for the Free instance type)
- The project in your own GitHub repository (see `GITHUB.md`)
- The AWS-side stack already deployed, including the Nginx TLS proxy
- `certs/ca.crt` from the AWS deployment (the public CA certificate only)
- The same HMAC secrets, Control Plane tokens, Cache API key, and database
  passwords that AWS uses

## 3. Create the web service

1. Sign in to Render.
2. Choose **New > Web Service**.
3. Connect your GitHub repository.
4. Configure:

| Setting | Value |
|---|---|
| Name | e.g. `mesh-render-side` |
| Region | Choose the closest free region |
| Branch | Your deployment branch |
| Runtime | **Docker** |
| Dockerfile path | `render/Dockerfile` |
| Docker build context | Repository root |
| Instance type | **Free** |
| Health check path | `/health` |
| Auto-deploy | Your choice |

Do **not** choose a paid instance type. Do **not** add a persistent disk; the free
plan does not include one and the project does not require it.

## 4. Upload the AWS CA certificate as a Secret File

The AWS endpoints use a free self-managed CA. Render must trust that CA to verify
the HTTPS and PostgreSQL connections.

1. Open the Render service.
2. Go to **Environment**.
3. Under **Secret Files**, choose **+ Add Secret File**.
4. Filename: `mesh-ca.crt`
5. Contents: paste the entire contents of `certs/ca.crt` from the AWS host.
6. Save the change.

At runtime the file is available at:

```text
/etc/secrets/mesh-ca.crt
```

Upload **only** `ca.crt`. Never upload `ca.key` or `server.key`.

For Docker services, Render mounts secret files at `/etc/secrets/<filename>`. The
`node` user in `render/Dockerfile` has group ID `1000`, which is the group Render
uses for secret files. If you change the Dockerfile user, keep it in group `1000`
or the container may get a permission error reading the CA file.

If Secret Files are not available in your Render workspace, the fallback is to set
`DB_SSL_CA_PEM` to the CA PEM text for PostgreSQL and to use a publicly trusted
certificate for the HTTP endpoints. Do not silently disable verification. See
section 11.

## 5. Environment variables

Render injects `PORT`; do not override it with a fixed port. Set the remaining
variables in the Render dashboard. Use the values from your deployment `.env`; do not
copy them into a repository.

### Required runtime

```dotenv
MESH_MODE=bundle
NODE_ENV=production
LOG_LEVEL=info

# AWS public endpoints. These are HTTPS because the EC2 Nginx proxy terminates
# TLS on these ports.
AWS_GATEWAY_URL=https://<aws-public-host>:8443
CONTROL_PLANE_URL=https://<aws-public-host>:8444
CACHE_API_URL=https://<aws-public-host>:8445

# PostgreSQL is reached through the Nginx TLS listener on 5433, never 5432.
POSTGRES_HOST=<aws-public-host>
POSTGRES_PORT=5433

# Verified TLS. Do not set DB_SSL_REJECT_UNAUTHORIZED=false.
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_PATH=/etc/secrets/mesh-ca.crt
NODE_EXTRA_CA_CERTS=/etc/secrets/mesh-ca.crt
```

`DB_SSL_CA_PATH` gives the PostgreSQL client the CA explicitly.
`NODE_EXTRA_CA_CERTS` makes Node's normal `fetch` calls trust the same CA when the
Render-side services call the AWS HTTPS endpoints.

### Database names and users

```dotenv
RENDER_DB_NAME=render_library
RENDER_DB_USER=render_app
RENDER_DB_PASSWORD=<same value as AWS .env>
AWS_DB_NAME=aws_library
AWS_DB_USER=aws_app
AWS_DB_PASSWORD=<same value as AWS .env>
```

The Book Replica Service does not write book data. The Member Service needs
`render_library`.

### Secrets

```dotenv
CACHE_API_KEY=<same value as AWS .env>
CONTROL_PLANE_ADMIN_TOKEN=<same value as AWS .env>
CONTROL_PLANE_SERVICE_TOKEN=<same value as AWS .env>
CONTROL_PLANE_READ_TOKEN=<same value as AWS .env>
AWS_TO_RENDER_HMAC_SECRET=<same value as AWS .env>
RENDER_TO_AWS_HMAC_SECRET=<same value as AWS .env>
RENDER_SUPERVISOR_TOKEN=<new strong random value>
```

`RENDER_SUPERVISOR_TOKEN` can be unique to Render because only the Render supervisor
status endpoints use it. Generate it with a password manager or Node.js
`crypto.randomBytes(32).toString('hex')`.

### Render-specific

```dotenv
RENDER_PUBLIC_BASE_URL=https://<render-service>.onrender.com
RENDER_INGRESS_ALLOWED_CLIENTS=api-gateway,borrow-service
RENDER_INGRESS_PORT=8081
RENDER_SUPERVISOR_PORT=5300
```

Do not set `BOOK_REPLICA_SERVICE_URL` or `MEMBER_SERVICE_URL` to Docker DNS names.
The supervisor already sets the correct loopback values inside the container:

```text
http://127.0.0.1:4104
http://127.0.0.1:4105
```

If you override them, use loopback addresses, not Docker service names.

## 6. Ports and health

- Render assigns `PORT`. The ingress binds to `0.0.0.0:$PORT`.
- Internal sidecars bind to `127.0.0.1` inside the container and are not publicly
  reachable.
- Health check path: `/health`.
- Public routes:
  - `/book-replica/*` (HMAC-protected)
  - `/member/*` (HMAC-protected)
  - `/health`, `/metrics`, `/` (metadata; no secrets)

Verify after deploy:

```bash
curl https://<render-service>.onrender.com/health
```

Expected: `status: healthy`, supervisor reachable, five processes running.

## 7. Connect AWS to Render

On the AWS side, set:

```dotenv
MEMBER_SIDECAR_URL=https://<render-service>.onrender.com/member
BOOK_REPLICA_URL=https://<render-service>.onrender.com/book-replica
```

Restart the AWS gateway and any component that reads these variables.

The gateway signs AWS -> Render requests with `AWS_TO_RENDER_HMAC_SECRET`. The
Render ingress verifies the signature, timestamp, nonce, client id, and path.

Test from AWS:

```bash
curl -i http://localhost:8080/api/members?limit=1
```

Expected: a real member response with `x-mesh-cloud: render`.

## 8. Connect Render to AWS

The Book Replica Service calls:

```text
AWS_GATEWAY_URL/cross-cloud/books...
```

and signs with `RENDER_TO_AWS_HMAC_SECRET`. The AWS gateway verifies the signature
and forces the request to the AWS primary sidecar.

The Render components also register with `CONTROL_PLANE_URL` and use
`CACHE_API_URL`. Both are HTTPS endpoints behind the EC2 Nginx proxy. The CA file
from section 4 is what makes those TLS connections verifiable.

## 9. Free-plan behavior you must expect

| Behavior | Effect |
|---|---|
| Sleep after about 15 minutes without inbound traffic | First request after sleep takes roughly a minute |
| 512 MB RAM | Keep the four processes plus ingress lightweight |
| Ephemeral filesystem | Do not store data locally; use PostgreSQL/Redis |
| No private networking to AWS | Cross-cloud calls use public HTTPS plus HMAC |
| Shared regional outbound IP ranges | Can be allowlisted, but shared with other Render customers |
| Automatic TLS on `onrender.com` | HTTPS at the Render edge, not end-to-end mTLS |
| No persistent disk | Secret Files are mounted read-only at runtime; they are not a writable disk |

The project does **not** use artificial keep-alive requests to prevent sleep. A
sleeping service is a documented free-tier limitation, not a bug.

### Render outbound IP ranges

Render Free services do not have a dedicated static egress IP. Render does publish
**shared regional outbound IP ranges** for each region; copy them from the service's
**Connect > Outbound** tab. You can use those ranges in the AWS security group, but
they are shared with other Render customers, so they are not an authentication
mechanism. Dedicated outbound IPs are paid and are not part of this project.

## 10. Cold start behavior

When Render wakes the service:

1. The container starts.
2. The supervisor starts the five child processes.
3. Each component registers with the Control Plane.
4. The ingress starts accepting signed requests.
5. The gateway may see a temporary failure until the Render side is ready.

The gateway's health-aware routing and retries handle this by failing over to AWS.
No fabricated data is returned.

## 11. TLS verification and the honest fallback

Recommended configuration:

```dotenv
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_PATH=/etc/secrets/mesh-ca.crt
NODE_EXTRA_CA_CERTS=/etc/secrets/mesh-ca.crt
```

This verifies both the PostgreSQL server certificate and the AWS HTTPS
certificates against the self-managed CA.

If Secret Files are unavailable in your workspace, the fallback is:

```dotenv
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_PEM=-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----
```

`DB_SSL_CA_PEM` covers PostgreSQL only. Node's `fetch` calls to the AWS HTTPS
endpoints still need a trusted CA, which requires a file. In that situation, use a
publicly trusted certificate on the AWS HTTP endpoints instead of the self-managed
one. Do not set `DB_SSL_REJECT_UNAUTHORIZED=false` or
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

If you do disable verification, the application logs a
`db_tls_verification_disabled` warning. That is a documented, temporary debugging
setting, not a secure deployment.

## 12. Troubleshooting on Render

| Symptom | Likely cause | Fix |
|---|---|---|
| Deploy fails at build | Wrong Dockerfile path | Use `render/Dockerfile` and repo root context |
| Service unhealthy | Missing required env var | Check Render logs for the named variable |
| `/health` shows fewer than five processes | A child crashed repeatedly | Check supervisor logs and restart counts |
| `401` from ingress | HMAC secret mismatch, clock skew, or replay | Verify secrets and sign fresh requests |
| `503` from ingress | Internal sidecar or breaker unavailable | Check sidecar health and breaker state |
| Cannot reach AWS gateway | AWS security group or URL | Open 8443 and use the current public host |
| Cannot reach Control Plane | AWS port 8444 or URL | Open 8444 to Render outbound ranges |
| Cannot reach Cache API | AWS port 8445 or URL | Open 8445 to Render outbound ranges |
| `self-signed certificate in certificate chain` | CA not trusted | Add `mesh-ca.crt` Secret File and set `NODE_EXTRA_CA_CERTS` |
| Database connection fails | 5433 blocked, TLS mismatch, or missing CA | Fix security group, `DB_SSL`, and `DB_SSL_CA_PATH` |
| `no pg_hba.conf entry ... SSL off` | PostgreSQL requires `hostssl` | Set `DB_SSL=true`; do not use plaintext |
| Public URL changed | Service renamed | Update AWS `MEMBER_SIDECAR_URL` and `BOOK_REPLICA_URL` |

## 13. Security notes

- Never put secrets in the Dockerfile or repository.
- Use Render's environment-variable UI, not a committed `.env`.
- Use different secrets for cloud than for local development.
- Upload only the public CA certificate as a Secret File; never upload private keys.
- Keep `DB_SSL_REJECT_UNAUTHORIZED=true` and `NODE_EXTRA_CA_CERTS` set.
- Treat the Render ingress as public and rely on HMAC plus the client allowlist.
- The supervisor status endpoint requires `RENDER_SUPERVISOR_TOKEN`.
- Do not expose internal sidecar ports through a second Render service or tunnel.

## 14. Manual checklist

- [ ] Render account created without payment details
- [ ] GitHub repository connected
- [ ] Docker web service with `render/Dockerfile`
- [ ] Free instance type selected
- [ ] `mesh-ca.crt` Secret File uploaded from `certs/ca.crt`
- [ ] `DB_SSL=true` and `DB_SSL_REJECT_UNAUTHORIZED=true`
- [ ] `DB_SSL_CA_PATH=/etc/secrets/mesh-ca.crt`
- [ ] `NODE_EXTRA_CA_CERTS=/etc/secrets/mesh-ca.crt`
- [ ] AWS URLs use `https://<aws-public-host>:8443` (gateway), `:8444`
      (Control Plane), and `:8445` (Cache API)
- [ ] `POSTGRES_PORT=5433`
- [ ] All other required environment variables set
- [ ] `RENDER_PUBLIC_BASE_URL` matches the actual service URL
- [ ] Deploy succeeds
- [ ] `/health` reports five running processes
- [ ] AWS `MEMBER_SIDECAR_URL` and `BOOK_REPLICA_URL` updated
- [ ] Signed AWS -> Render request succeeds
- [ ] Signed Render -> AWS request succeeds
- [ ] Render components visible in the Control Plane registry
- [ ] Sleep/wake behavior understood and documented
