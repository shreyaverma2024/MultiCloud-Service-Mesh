# Free-Tier Limits and Zero-Cost Notes

The project is designed to require **zero personal spending**. This document records
the limits that matter and the choices that keep the project free.

Platform terms change. Verify the current limits in your AWS Academy lab and Render
dashboard before deploying.

## 1. Zero-cost rules used by this project

- Only free and open-source software: Node.js, Express, React, Vite, PostgreSQL,
  Redis, Docker, Jest, Recharts.
- No paid AWS service.
- No paid Render plan.
- No subscription, trial that requires a card, or paid upgrade.
- No artificial keep-alive requests to defeat sleep or idle limits.
- No extra infrastructure beyond the agreed architecture.
- No secrets in source control.
- No deployment performed by the coding agent.

## 2. AWS Academy limits

AWS Academy Learner Lab is a course environment, not a personal AWS account. Typical
constraints:

| Limit | Typical value | Effect on this project |
|---|---|---|
| Lab credit | Fixed course credit | Enough for one small EC2 instance and EBS |
| Session length | A few hours per lab session | Restart the instance each session |
| Instance types | Small burstable types such as `t2.micro`/`t3.micro` | 1 GB RAM is tight but workable |
| Region | Often fixed | Deploy where the lab allows |
| IAM | Restricted roles | Do not rely on advanced IAM features |
| Elastic IP | May be restricted or limited | Public IP may change after stop/start |
| Billing console | Not available | You cannot enable paid services anyway |

### Resources to avoid

These are outside the design and may consume credit or be blocked:

- RDS
- NAT Gateway
- Application/Network Load Balancer
- ECS, EKS, Fargate
- Route 53 hosted zones
- CloudFront with paid features
- Savings Plans or Reserved Instances
- Large EBS volumes or snapshots
- Data transfer beyond the free/lab allowance

### Practical cost control

- Use one small EC2 instance.
- Keep one EBS volume.
- Stop the instance when not in use, if the lab allows it.
- Do not create duplicate environments.
- Delete unused images and containers with `docker system prune`.
- Monitor the lab credit indicator.
- Do not use keep-alive traffic to hold a session open.

## 3. Render Free limits

Typical Render Free web service limits:

| Limit | Typical value | Effect on this project |
|---|---|---|
| Instance hours | 750 per month across free services | One always-on service is about 730 hours |
| RAM | 512 MB | Four Node processes plus ingress must stay small |
| CPU | Shared/low | Expect modest throughput |
| Sleep | After about 15 minutes without inbound traffic | Cold start of roughly a minute |
| Bandwidth | Monthly allowance | Keep responses small |
| Build minutes | Monthly allowance | Avoid unnecessary rebuilds |
| Disk | Ephemeral | No persistent local data |
| Custom domain | Free service gets an `onrender.com` subdomain | TLS at the Render edge |
| Private networking | Not to AWS | Cross-cloud uses public HTTPS plus HMAC |
| Outbound IPs | Shared regional ranges | Can be allowlisted, but not a per-service identity |
| Dedicated outbound IPs | Paid feature | Not used in this zero-cost project |

The project runs **one** Render web service, not five, specifically to stay within
the free instance-hour allowance and the agreed architecture.

Render publishes shared regional outbound IP ranges in the service dashboard. You
can use them in the AWS security group, but they are shared with other Render
customers, so TLS, HMAC, API keys, and database passwords remain the real controls.

### Free TLS on AWS

The AWS side uses one free Nginx container and a self-managed CA generated with
OpenSSL. There is no paid certificate, managed load balancer, or paid TLS service.
Nginx adds only a few megabytes of memory to the EC2 instance.

### Why the project does not keep Render awake

Artificial keep-alive requests would:

- violate the project's zero-cost and honesty rules
- hide a real free-tier behavior
- create unnecessary traffic and logs

Instead, the mesh handles a sleeping Render service with health-aware routing,
failover, retries, and clear health reporting.

## 4. Database and cache limits

- PostgreSQL and Redis run as containers on the EC2 instance. There is no managed
  database bill, but there is also no managed backup, failover, or scaling.
- One PostgreSQL server hosts two logical databases. This matches the architecture
  and avoids a second paid database.
- One Redis instance is used. It is never published publicly.
- Backups are plain SQL files in `backups/`, which is git-ignored. Copy them off the
  instance if the lab may reset.

## 5. GitHub limits

- Public and private repositories are free.
- GitHub Actions is not required for this project.
- Do not store secrets in the repository.
- Do not enable paid features.

## 6. What still costs nothing but has a real cost in quality

| Trade-off | Consequence |
|---|---|
| Free Render sleep | Cold starts during demos |
| Small EC2 instance | Limited concurrent load |
| Self-managed PostgreSQL | Manual backup, no HA |
| Single Redis | Cache outage requires PostgreSQL fallback |
| No end-to-end mTLS | HMAC authenticates requests but does not encrypt end to end |
| Self-managed CA | Clients must be given the CA; server cert must be regenerated when the EC2 host changes |
| Single Nginx proxy | A proxy failure makes the public AWS endpoints unavailable |
| Process isolation on Render | Weaker than separate containers |
| Single gateway process | In-memory nonce store is not shared across replicas |

These are documented limitations, not hidden failures.

## 7. When a feature cannot be free

If a requirement truly needs a paid capability, the honest options are:

1. Explain the limitation and keep the free implementation.
2. Replace the feature with a genuinely free alternative that preserves the
   architecture.
3. Ask the user before changing the architecture.

Do not enable a paid trial, enter payment details, or silently downgrade security.

## 8. Cost checklist before deployment

- [ ] No payment card entered anywhere
- [ ] Only Free Render instance type selected
- [ ] Only the lab's small EC2 instance used
- [ ] No RDS, NAT Gateway, load balancer, or managed cache
- [ ] One Render web service only
- [ ] One EC2 instance and one EBS volume
- [ ] No keep-alive traffic
- [ ] No paid domain or hosted zone
- [ ] No paid GitHub plan
- [ ] Secrets kept out of Git
- [ ] Backups stored privately
