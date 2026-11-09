# AWS Academy EC2 Deployment Guide

This guide prepares the AWS-side deployment **for you to execute manually**. The
coding agent did not log in to AWS, create resources, or deploy anything.

AWS Academy Learner Lab accounts differ between courses. Verify every limit and
available instance type in your own lab before starting.

## 1. What runs on AWS

The `aws` Docker Compose profile starts:

- PostgreSQL 16 (one server, two logical databases)
- Redis 7 (exactly one instance)
- Cache API
- Control Plane
- Book Service + Book Primary Sidecar
- Borrow Service + Borrow Sidecar
- Notification Service + Notification Sidecar
- API Gateway
- Dashboard
- **One Nginx TLS proxy** (free edge proxy, not an application service or sidecar)

The Render-side Book Replica Service, Book Replica Sidecar, Member Service, Member
Sidecar, and Render ingress run on Render Free, not on EC2.

The Nginx proxy does not change the required architecture counts. There are still
exactly five application services and five independent sidecars.

## 2. Recommended lab resources

| Resource | Recommendation | Notes |
|---|---|---|
| EC2 instance | `t3.micro` or `t2.micro` if available | 1 vCPU / 1 GB is tight but workable |
| Larger instance | `t3.small` only if your lab allows it | More headroom for the containers |
| AMI | Ubuntu Server 22.04 or 24.04 LTS | Amazon Linux also works |
| Storage | 20-30 GB gp2/gp3 | Docker images need space |
| Security group | Custom, least privilege | See below |
| Elastic IP | Only if your lab allows it | Otherwise the public IP can change |
| Key pair | Create/download once | Never commit the `.pem` file |
| TLS | Self-managed CA + Nginx | Free; no paid certificate |

Do **not** create RDS, NAT Gateway, Application Load Balancer, Route 53 hosted
zones, ECS/EKS, or other paid resources. They are outside the zero-cost design.

The Nginx container adds only a few megabytes of memory. On a 1 GB instance it is
still safer to avoid extra shells, builds, and duplicate containers while the
stack is running.

## 3. Security group rules

Minimum inbound rules:

| Port | Source | Purpose |
|---:|---|---|
| 22 | Your public IP only | SSH administration |
| 8443 | Render outbound ranges + your IP if practical | Public API Gateway through Nginx TLS |
| 8444 | Render outbound ranges + your IP if practical | Control Plane through Nginx TLS |
| 8445 | Render outbound ranges + your IP if practical | Cache API through Nginx TLS |
| 5433 | Render outbound ranges | PostgreSQL through Nginx TLS |

Do **not** open `8080`, `4000`, `4100`, `5432`, `6379`, `4101-4105`,
`5101-5105`, or `5300` to the internet. The deployment override binds the
gateway, dashboard, Control Plane, and PostgreSQL to loopback or the private
Docker network. Nginx reaches them over that private network.

The dashboard is kept on loopback. Access it with an SSH tunnel instead of opening
port 3000:

```bash
ssh -i <your-key>.pem -L 3000:127.0.0.1:3000 ubuntu@<ec2-public-dns>
# Then open http://localhost:3000 on your laptop.
```

### Render outbound IP ranges

Render Free services use **shared regional outbound IP ranges**, not a dedicated
static IP per service. You can copy the current ranges from the Render dashboard:
open the service, choose **Connect**, then the **Outbound** tab.

Use those ranges as a security-group allowlist. They are shared with other Render
customers in the same region, so the allowlist reduces exposure but does not prove
that a request came from your service. TLS, HMAC, API keys, and strong database
passwords remain the actual authentication controls.

Dedicated outbound IPs are a paid Render feature. Do not enable them for this
zero-cost project.

## 4. Prepare the instance

SSH in:

```bash
ssh -i <your-key>.pem ubuntu@<ec2-public-dns>
```

Install Docker, Compose, and OpenSSL:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in so the group change applies, then verify:

```bash
docker version
docker compose version
openssl version
```

The deployment override uses the Compose `!override` tag to force loopback port
bindings. Use a recent Docker Compose v2 release that supports it; the official
`docker-compose-plugin` installed above is current. Compose v2.24.4 or newer is
recommended.

## 5. Get the project onto EC2

Use your own GitHub repository (see `GITHUB.md`). On the instance:

```bash
git clone https://github.com/<your-account>/<your-repo>.git
cd <your-repo>
```

If the repository is private, use a deploy key or a personal access token that you
create and keep private. Do not paste tokens into shared logs.

## 6. Configure `.env` on EC2

```bash
npm install
npm run secrets
```

`npm run secrets` needs Node.js. Install it with your preferred free method, or copy
`.env.example` to `.env` and fill every `__GENERATE__` value with a unique random
value generated locally. Never reuse the local development secrets for the cloud.

Set these deployment-specific values in `.env`:

```dotenv
MESH_MODE=split
COMPOSE_PROFILES=aws

# AWS services connect to PostgreSQL over the private Docker network, but the
# connection still uses TLS because pg_hba.conf requires hostssl.
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_PATH=/etc/mesh-certs/ca.crt
MESH_REQUIRE_DB_TLS=true

# Public Render ingress paths (Render side)
MEMBER_SIDECAR_URL=https://<render-service>.onrender.com/member
BOOK_REPLICA_URL=https://<render-service>.onrender.com/book-replica
```

`docker-compose.deploy.yml` forces the gateway, dashboard, Control Plane, and
PostgreSQL onto loopback or the private network. You do **not** need to set
`CONTROL_PLANE_BIND=0.0.0.0`.

The Render service must use the same HMAC secrets, Control Plane tokens, Cache API
key, and database passwords. Copy those values through a secure channel; never
commit them.

## 7. Generate the free TLS certificates

From the repository root on the EC2 instance:

```bash
./deploy/tls/gen-certs.sh <aws-public-dns> <aws-public-ip>
```

Example:

```bash
./deploy/tls/gen-certs.sh ec2-1-2-3-4.compute.amazonaws.com 1.2.3.4
```

This creates:

| File | Purpose | Secret? |
|---|---|---|
| `certs/ca.crt` | Self-managed CA certificate | No |
| `certs/ca.key` | CA private key | **Yes** |
| `certs/server.crt` | Server certificate for Nginx and PostgreSQL | No |
| `certs/server.key` | Server private key | **Yes** |

The certificate includes these SANs:

- `DNS:postgres` (Nginx verifies PostgreSQL's certificate)
- `DNS:localhost`
- `DNS:<aws-public-host>`
- `IP:127.0.0.1`
- `IP:<aws-public-ip>`

The script reuses an existing CA. If the EC2 public host or IP changes, rerun it
with the new values and restart the stack. Render does **not** need a new CA file
unless you set `NEW_CA=1`.

`certs/` is git-ignored. Never commit or share `ca.key` or `server.key`.

### Why self-managed certificates

A public certificate authority is not required for this project. A self-managed CA
is free, works without a stable public DNS name, and lets both Render and Nginx
verify the certificate explicitly.

A free public CA such as Let's Encrypt is a reasonable alternative **if** your lab
gives you a stable public DNS name and you can complete domain validation. It is
not the default here because AWS Academy public DNS names and IPs can change
between lab sessions, which would require repeated certificate issuance. Do not
pay for a certificate.

## 8. Start the AWS profile

```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws up -d --build
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws ps
```

Do **not** also pass `docker-compose.postgres-tls.yml`; `docker-compose.deploy.yml`
already enables PostgreSQL TLS. Passing both duplicates the same mounts and
settings.

`docker-compose.deploy.yml` publishes only:

| Port | Backend |
|---:|---|
| 8443 | API Gateway (TLS) |
| 8444 | Control Plane (TLS) |
| 8445 | Cache API (TLS) |
| 5433 | PostgreSQL (TLS, verified end to end) |

Redis, application services, sidecars, the supervisor, and the direct PostgreSQL
port stay private.

Wait for health, then check from the EC2 instance:

```bash
curl http://localhost:8080/health
curl http://localhost:4000/health
curl --cacert certs/ca.crt https://localhost:8443/health
curl --cacert certs/ca.crt https://localhost:8444/health
curl --cacert certs/ca.crt https://localhost:8445/health
```

From your laptop, copy `certs/ca.crt` over a secure channel and use:

```bash
curl --cacert ca.crt https://<ec2-public-dns>:8443/health
```

If this fails, re-check the security group, the public IPv4 address, and whether
the certificate SAN matches the host you used.

## 9. PostgreSQL TLS and certificate verification

PostgreSQL port `5432` is never published. Render connects to Nginx on `5433`;
Nginx terminates the client TLS connection and opens a second TLS connection to
PostgreSQL. Both hops use certificates signed by the self-managed CA.

The deployment sets:

```dotenv
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_PATH=/etc/mesh-certs/ca.crt
MESH_REQUIRE_DB_TLS=true
```

`db/init/02-require-tls.sh` rewrites `pg_hba.conf` on a fresh volume so every TCP
connection must use TLS and SCRAM-SHA-256:

```text
local   all   all                       trust
hostssl all   all   0.0.0.0/0           scram-sha-256
hostssl all   all   ::/0                scram-sha-256
```

`db/tls-entrypoint.sh` copies the bind-mounted server key to a container-local
path and fixes ownership so the `postgres` user can read it without making the key
world-readable.

Verify from your laptop (do not paste the password into shared logs):

```bash
PGPASSWORD='<render_app password>' psql \
  "host=<ec2-public-dns> port=5433 dbname=render_library user=render_app \
   sslmode=verify-full sslrootcert=ca.crt" \
  -c 'SELECT 1;'
```

Expected: `1`.

If the EC2 public host or IP changes, regenerate only the server certificate with
the same CA and restart:

```bash
./deploy/tls/gen-certs.sh <new-public-dns> <new-public-ip>
docker compose -f docker-compose.yml -f docker-compose.deploy.yml \
  --profile aws up -d --force-recreate postgres nginx
```

### Honest limitation

A self-managed CA is not trusted by public browsers or arbitrary clients. Any
client must be given `certs/ca.crt`. If you set
`DB_SSL_REJECT_UNAUTHORIZED=false`, the connection is encrypted but the server
identity is not verified; the application logs a warning and this project does not
recommend it. Keep verification on.

## 10. Verify cross-cloud traffic

From the EC2 instance, the gateway should route about 70% of book reads to AWS and
30% to Render:

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -D - http://localhost:8080/api/books?limit=1 | grep -i x-mesh-cloud
done
```

Expected: a mix of `aws` and `render`.

Check Render registration through the internal Control Plane:

```bash
curl -H "x-read-token: <CONTROL_PLANE_READ_TOKEN>" \
  http://localhost:4000/api/registry/services
```

Or through the public TLS endpoint:

```bash
curl --cacert certs/ca.crt \
  -H "x-read-token: <CONTROL_PLANE_READ_TOKEN>" \
  https://<ec2-public-dns>:8444/api/registry/services
```

Expected: Render components appear with `cloud: render`. Their advertise URLs point
at the public Render ingress, not at private ports.

## 11. Backup before stopping

```bash
npm run db:backup
```

The `backups/` directory is git-ignored. Copy backups off the instance if you need
them after the lab is reset. The instance's EBS volume may be reset between courses.

## 12. Common AWS Academy problems

| Problem | Likely cause | Fix |
|---|---|---|
| Cannot SSH | Security group or wrong key | Allow your IP on 22; use the correct `.pem` |
| TLS certificate error from `curl` | Self-managed CA not supplied | Add `--cacert certs/ca.crt` |
| Certificate name mismatch | EC2 public host/IP changed | Rerun `deploy/tls/gen-certs.sh` and restart |
| Nginx fails to start | Missing `certs/` files | Run `deploy/tls/gen-certs.sh` first |
| PostgreSQL will not start | Key permissions or missing certs | Check `db/tls-entrypoint.sh` and the `certs/` mount |
| `no pg_hba.conf entry ... SSL off` | Client did not enable TLS | Set `DB_SSL=true` and the CA path |
| Render cannot reach gateway | Port 8443 closed or wrong URL | Open 8443 and update `AWS_GATEWAY_URL` |
| Render cannot reach Control Plane | Port 8444 closed | Open 8444 to Render outbound ranges |
| Render cannot reach Cache API | Port 8445 closed | Open 8445 to Render outbound ranges |
| Member Service cannot reach PostgreSQL | Port 5433 closed or TLS mismatch | Open 5433, verify `DB_SSL` and the CA |
| Public IP changed | Instance stopped/started | Update Render URLs and regenerate the server cert |
| Lab session expired | AWS Academy limit | Restart the lab and the instance |
| Out of disk | Docker images and logs | `docker system prune`, increase EBS if allowed |

## 13. What not to do

- Do not create paid AWS resources.
- Do not enable a NAT Gateway or load balancer for this project.
- Do not publish Redis, PostgreSQL `5432`, the gateway `8080`, the Control Plane
  `4000`, or the Cache API `4100`.
- Do not disable PostgreSQL certificate verification without documenting it.
- Do not commit `.env`, `.pem`, `certs/ca.key`, or `certs/server.key`.
- Do not use artificial keep-alive traffic to keep the lab alive.
- Do not claim the deployment is production-grade.

## 14. Manual checklist

- [ ] EC2 instance running with Ubuntu
- [ ] Docker, Compose, and OpenSSL installed
- [ ] Repository cloned
- [ ] `.env` created with fresh secrets
- [ ] `MEMBER_SIDECAR_URL` and `BOOK_REPLICA_URL` point to Render HTTPS
- [ ] `DB_SSL=true`, `DB_SSL_REJECT_UNAUTHORIZED=true`, `DB_SSL_CA_PATH` set
- [ ] `MESH_REQUIRE_DB_TLS=true`
- [ ] `./deploy/tls/gen-certs.sh` run with the current public host and IP
- [ ] `certs/ca.crt` copied to Render as a Secret File
- [ ] Security group allows only 22, 8443, 8444, 8445, 5433
- [ ] `docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile aws up -d --build` succeeds
- [ ] All AWS-side containers healthy, including `mesh-tls-proxy`
- [ ] Gateway reachable from the internet over HTTPS with the CA
- [ ] PostgreSQL reachable on 5433 with `sslmode=verify-full`
- [ ] Render components register with the Control Plane
- [ ] Cross-cloud signed requests succeed
- [ ] Backup taken
