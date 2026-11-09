# API Reference

All backend components use a consistent JSON envelope.

Success:

```json
{
  "data": {},
  "meta": {}
}
```

Failure:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```

`meta` and `details` are optional. Most responses include `meta.requestId`.

## 1. Authentication headers

| Scope | Header | Used by |
|---|---|---|
| Admin | `x-admin-token: <CONTROL_PLANE_ADMIN_TOKEN>` | Operator / dashboard weight update |
| Service | `x-service-token: <CONTROL_PLANE_SERVICE_TOKEN>` | Components registering, heartbeating, reading routing/config |
| Read | `x-read-token: <CONTROL_PLANE_READ_TOKEN>` | Dashboard BFF and read-only monitoring |
| Cache API | `x-api-key: <CACHE_API_KEY>` | Services using the Cache API |
| HMAC AWS -> Render | `x-mesh-client`, `x-mesh-timestamp`, `x-mesh-nonce`, `x-mesh-signature` | API Gateway and Borrow Service to Render ingress |
| HMAC Render -> AWS | same four headers | Book Replica Service to Gateway `/cross-cloud/books` |

Bearer tokens are also accepted by the Control Plane when the token matches one of
the configured scopes.

## 2. API Gateway (`http://localhost:8080`)

The gateway is the client entry point. It routes to sidecars, never directly to
application services.

### `GET /`

Returns the gateway component name, route list, and health/metrics paths.

### `GET /health`

Returns gateway health, Control Plane reachability, routing version, and the number
of routable book targets.

### `GET /metrics`

Returns real gateway metrics, per-target metrics, circuit-breaker snapshots,
observed traffic counts, failovers, retries, and configured weights.

### `GET /api/books`

Weighted read route. Default policy is 70% AWS / 30% Render.

Query parameters:

| Parameter | Type | Default | Notes |
|---|---|---:|---|
| `limit` | integer | 20 | 1-100 |
| `offset` | integer | 0 | >= 0 |
| `category` | string | - | exact category |
| `search` | string | - | title/author/ISBN search |

Response headers include:

- `x-mesh-route`
- `x-mesh-target` (`book-primary-sidecar` or `book-replica-sidecar`)
- `x-mesh-cloud` (`aws` or `render`)
- `x-mesh-config-version`
- `x-mesh-attempts`
- `x-mesh-failover` when a retry/failover occurred, including when the alternate
  target also failed (the final status still reflects the last attempt)

### `GET /api/books/:id`

Weighted read for a single book. Same target headers as the list route.

### `GET /api/books/search?q=<text>`

Weighted read that forwards to the selected book service.

### `GET /api/books/:id/availability`

Weighted read of copy availability.

### Non-read `/api/books/*`

Any non-GET/HEAD method is forced to the authoritative AWS primary sidecar and
ignores the public weight. The current application does not expose book writes;
this rule protects future write endpoints.

### `GET /api/borrows`

Routes through `borrow-sidecar`.

Query parameters: `limit`, `memberId`, `bookId`, `status`.

### `POST /api/borrows`

Creates a borrow. Request body:

```json
{
  "bookId": 1,
  "memberId": 1,
  "days": 14
}
```

Validates the member through the Render member sidecar, validates the book, creates
the borrow transactionally, decrements availability, creates a notification, and
invalidates the book cache.

### `POST /api/borrows/:id/return`

Returns a borrowed book and creates a return notification.

### `GET /api/borrows/:id`

Returns one borrow record.

### `GET /api/notifications`

Routes through `notification-sidecar`. Query parameters: `limit`, `memberId`,
`status`, `type`.

### `POST /api/notifications`

```json
{
  "memberId": 1,
  "bookId": 1,
  "type": "SYSTEM",
  "message": "Maintenance notice"
}
```

### `PATCH /api/notifications/:id/status`

```json
{
  "status": "SENT"
}
```

Allowed statuses: `PENDING`, `SENT`, `FAILED`.

### `GET /api/members`

Routes through the Render member sidecar. Query parameters: `limit`, `search`.

### `GET /api/members/:id`

Returns one member.

### `POST /api/members`

```json
{
  "name": "New Member",
  "email": "member@example.com",
  "phone": "+1-555-0100",
  "membershipType": "BASIC"
}
```

`membershipType` is one of `BASIC`, `PREMIUM`, `STUDENT`.

### `GET /cross-cloud/books*`

Internal Render -> AWS route. Requires a valid HMAC signature with
`RENDER_TO_AWS_HMAC_SECRET`, client `book-replica-service`, and an unused nonce.
The path is rewritten to `/api/books*` and forced to the AWS primary sidecar.
Unsigned, tampered, stale, or replayed requests receive `401`.

## 3. Application services (internal)

These ports are not published locally. They are reached through sidecars.

### Book Service (`4101`)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | DB and cache status |
| GET | `/ready` | 503 until PostgreSQL is ready |
| GET | `/metrics` | Real service metrics |
| GET | `/api/books` | `limit`, `offset`, `category`, `search` |
| GET | `/api/books/search` | `q`, `limit` |
| GET | `/api/books/:id` | 404 when missing |
| GET | `/api/books/:id/availability` | copy availability |

Book reads use Redis through the Cache API and fall back to PostgreSQL when Redis
is unavailable. `meta.cache` is `hit`, `miss`, or `fallback`.

### Borrow Service (`4102`)

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/ready`, `/metrics` | status and metrics |
| POST | `/api/borrows` | create borrow |
| POST | `/api/borrows/:id/return` | return borrow |
| GET | `/api/borrows` | list with filters |
| GET | `/api/borrows/:id` | single borrow |

Borrow creation uses a PostgreSQL transaction with `SELECT ... FOR UPDATE` to avoid
double allocation. Unavailable books return `409 BOOK_UNAVAILABLE`.

### Notification Service (`4103`)

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/ready`, `/metrics` | status and metrics |
| POST | `/api/notifications` | create notification |
| GET | `/api/notifications` | filter by member/status/type |
| GET | `/api/notifications/:id` | single notification |
| PATCH | `/api/notifications/:id/status` | update delivery status |

### Book Replica Service (`4104`, Render)

Read-only endpoints:

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/ready`, `/metrics` | status and metrics |
| GET | `/api/books` | fetch authoritative list through Gateway |
| GET | `/api/books/search` | authoritative search |
| GET | `/api/books/:id` | authoritative single book |
| GET | `/api/books/:id/availability` | authoritative availability |

It never writes book data. It caches results through the Cache API and signs every
AWS-bound request with a fresh HMAC.

### Member Service (`4105`, Render)

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/ready`, `/metrics` | status and metrics |
| POST | `/api/members` | register member |
| GET | `/api/members` | list/search |
| GET | `/api/members/:id` | single member, cached |

## 4. Control Plane (`http://127.0.0.1:4000`)

The Control Plane handles management traffic only. It never proxies application
data-plane requests.

### Public status

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Mode, DB status, registry size |
| GET | `/metrics` | read | Control Plane metrics |

### Registry

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/registry/register` | service | Register service/sidecar/gateway/etc. |
| POST | `/api/registry/heartbeat` | service | Status, metrics, metadata, config version |
| POST | `/api/registry/deregister` | service | Graceful deregistration |
| DELETE | `/api/registry/:id` | admin | Remove a component |
| GET | `/api/registry/services` | service or read | List with `kind`, `cloud`, `name` filters |
| GET | `/api/registry/services/:id` | service or read | Single component |

### Routing and configuration

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/routing` | service or read | Current policy and routable targets |
| PUT | `/api/routing/book/weights` | admin | Update book weights |
| GET | `/api/config/sidecar/:name` | service | Sidecar timeout/retry/breaker config |

Weight update body:

```json
{
  "aws": 70,
  "render": 30
}
```

Rules: both values are integers 0-100, and their sum must be exactly 100. The
`x-operator` header is recorded in the event log. A successful response returns the
new version and weights.

### Monitoring

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/mesh/status` | read | Full dashboard snapshot |
| GET | `/api/alerts` | read | Active alerts |
| GET | `/api/events` | read | Filter by `severity`, `source`, `cloud`, `type`, `since`, `limit` |
| POST | `/api/events` | service | Record a real component event |

## 5. Cache API (`4100`, internal)

All routes except `/health` require `x-api-key: <CACHE_API_KEY>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Redis availability and latency |
| GET | `/metrics` | Hits, misses, hit ratio, Redis status |
| GET | `/cache/:namespace/:key` | Get a value and remaining TTL |
| PUT | `/cache/:namespace/:key` | Set `{ "value": ..., "ttlSeconds": 60 }` |
| DELETE | `/cache/:namespace/:key` | Delete one key |
| POST | `/cache/invalidate` | Delete all keys in `{ "namespace": "..." }` |

When Redis is unavailable, cache operations return
`503 CACHE_UNAVAILABLE`; callers must use PostgreSQL.

## 6. Dashboard BFF (`http://localhost:3000`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Dashboard and Control Plane reachability |
| ALL | `/api/*` | Server-side proxy to the Control Plane with the read token |
| GET | `/` | React application |

The browser never receives `CONTROL_PLANE_READ_TOKEN`,
`CONTROL_PLANE_SERVICE_TOKEN`, `CONTROL_PLANE_ADMIN_TOKEN`, database passwords,
Redis password, HMAC secrets, or the supervisor token. Weight updates must include
an operator-entered `x-admin-token`; the dashboard does not persist it.

## 7. Render ingress (`http://127.0.0.1:8081` in bundle mode)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Ingress metadata and route list |
| GET | `/health` | Supervisor reachability and process summary |
| GET | `/metrics` | Ingress metrics |
| GET | `/supervisor/status` | Admin-token-protected supervisor detail |
| ALL | `/book-replica/*` | HMAC-protected route to Book Replica Sidecar |
| ALL | `/member/*` | HMAC-protected route to Member Sidecar |

Every `/book-replica/*` and `/member/*` request must be signed with
`AWS_TO_RENDER_HMAC_SECRET` and come from an allowed client
(`api-gateway` or `borrow-service` by default). The ingress strips the public prefix
before forwarding to the private sidecar.

## 8. Common status codes

| Status | Meaning |
|---:|---|
| 200 | Success |
| 201 | Resource created |
| 400 | Validation error or invalid weights |
| 401 | Missing/invalid token, HMAC failure, or replay |
| 404 | Resource or component not found |
| 409 | Business conflict (book unavailable, already returned, duplicate email) |
| 502 | Upstream unavailable |
| 503 | No healthy target, cache unavailable, database not ready, or circuit open |
| 504 | Upstream timeout |
