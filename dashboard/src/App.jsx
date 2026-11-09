import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell
} from 'recharts';

const POLL_MS = 2000;
const STATUS_COLORS = {
  healthy: '#22c55e',
  degraded: '#f59e0b',
  unhealthy: '#ef4444',
  unknown: '#94a3b8',
  not_registered: '#94a3b8',
  critical: '#ef4444'
};
const STATUS_LABELS = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown / Disconnected',
  not_registered: 'Not registered',
  critical: 'Critical'
};
const CLOUD_COLORS = { aws: '#38bdf8', render: '#a78bfa' };

function statusLabel(status) {
  return STATUS_LABELS[status] || status || 'Unknown';
}

function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.unknown;
}

function fmt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString();
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(1)}%`;
}

function ms(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(0)} ms`;
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta < 2000) return 'just now';
  if (delta < 60000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3600000) return `${Math.round(delta / 60000)}m ago`;
  return `${Math.round(delta / 3600000)}h ago`;
}

function StatusPill({ status }) {
  return (
    <span className="status-pill" style={{ '--status': statusColor(status) }}>
      <span className="status-dot" />
      {statusLabel(status)}
    </span>
  );
}

function MetricCard({ label, value, detail, status, accent }) {
  return (
    <div className={`metric-card ${accent ? `accent-${accent}` : ''}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={status ? { color: statusColor(status) } : undefined}>
        {value}
      </div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </div>
  );
}

function Panel({ title, subtitle, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function Node({ title, subtitle, status, detail }) {
  return (
    <div className={`topology-node node-${status}`} title={detail || title}>
      <div className="node-title">{title}</div>
      {subtitle ? <div className="node-subtitle">{subtitle}</div> : null}
      <div className="node-status" style={{ color: statusColor(status) }}>
        <span className="status-dot" />
        {statusLabel(status)}
      </div>
    </div>
  );
}

function Arrow({ label }) {
  return (
    <div className="topology-arrow">
      <span>{label}</span>
      <b>→</b>
    </div>
  );
}

function Topology({ snapshot, connected }) {
  const byId = useMemo(
    () => Object.fromEntries((snapshot?.components || []).map((component) => [component.id, component])),
    [snapshot]
  );
  const expected = snapshot?.expected || [];
  const statusOf = (id) => {
    if (!connected) return 'unknown';
    return byId[id]?.status || expected.find((item) => item.id === id)?.status || 'unknown';
  };
  const configured = snapshot?.routing?.configured || { aws: 70, render: 30 };
  const observed = snapshot?.routing?.observed || {};
  const redisStatus = snapshot?.cache?.redis?.available ? 'healthy' : 'unhealthy';
  const databaseStatus = snapshot?.mesh?.databaseConnected ? 'healthy' : 'unknown';

  const Pair = ({ sidecar, service, label }) => (
    <div className="topology-pair">
      <Node
        title={label}
        subtitle={sidecar}
        status={statusOf(sidecar)}
        detail={`Sidecar: ${sidecar}`}
      />
      <span className="pair-arrow">→</span>
      <Node
        title="Service"
        subtitle={service}
        status={statusOf(service)}
        detail={`Application service: ${service}`}
      />
    </div>
  );

  return (
    <Panel
      title="Architecture topology"
      subtitle="Client → API Gateway → independent sidecars → services. AWS and Render are separated explicitly."
      className="topology-panel"
    >
      <div className="topology">
        <div className="topology-row">
          <Node title="Client" subtitle="HTTP client" status={connected ? 'healthy' : 'unknown'} />
          <Arrow label="requests" />
          <Node
            title="API Gateway"
            subtitle="AWS Academy EC2"
            status={statusOf('api-gateway')}
            detail="Weighted routing, failover, retries, circuit breakers"
          />
          <div className="weight-note">
            <span className="aws-text">AWS {configured.aws}%</span>
            <span className="render-text">Render {configured.render}%</span>
          </div>
        </div>

        <div className="topology-columns">
          <div className="cloud-group aws-group">
            <div className="cloud-heading">
              <span className="cloud-badge aws-badge">AWS Academy EC2</span>
              <span className="cloud-note">Separate containers for services and sidecars</span>
            </div>
            <div className="pair-grid">
              <Pair sidecar="book-primary-sidecar" service="book-service" label="Book Primary" />
              <Pair sidecar="borrow-sidecar" service="borrow-service" label="Borrow" />
              <Pair sidecar="notification-sidecar" service="notification-service" label="Notification" />
            </div>
            <div className="infra-grid">
              <Node title="Control Plane" subtitle="registration · discovery · config" status={statusOf('control-plane')} />
              <Node title="Cache API" subtitle="authenticated Redis access" status={statusOf('cache-api')} />
              <Node
                title="Redis"
                subtitle="exactly one instance · private"
                status={redisStatus}
                detail="Redis is never exposed publicly. Port 6379 is not published."
              />
            </div>
            <div className="database-node">
              <Node
                title="PostgreSQL"
                subtitle="aws_library + render_library"
                status={databaseStatus}
                detail="One self-managed PostgreSQL server with two logical databases."
              />
            </div>
          </div>

          <div className="cloud-group render-group">
            <div className="cloud-heading">
              <span className="cloud-badge render-badge">Render Free</span>
              <span className="cloud-note">ONE web service · four supervised processes + ingress</span>
            </div>
            <div className="render-ingress">
              <Node
                title="Ingress Dispatcher"
                subtitle="public $PORT · 0.0.0.0"
                status={statusOf('render-ingress')}
                detail="Routes /book-replica and /member to the correct internal sidecar. Internal ports stay private."
              />
              <Arrow label="HMAC" />
              <Node
                title="Process Supervisor"
                subtitle="restart + process health"
                status={statusOf('render-supervisor')}
                detail="Process-level isolation only, not separate-container isolation."
              />
            </div>
            <div className="pair-grid">
              <Pair sidecar="book-replica-sidecar" service="book-replica-service" label="Book Replica" />
              <Pair sidecar="member-sidecar" service="member-service" label="Member" />
            </div>
            <div className="render-note">
              The Book Replica is read-only. It fetches authoritative data from AWS through the
              HMAC-protected <code>/cross-cloud/books</code> path.
            </div>
          </div>
        </div>

        <p className="hint">
          Configured book weights: AWS {configured.aws}% / Render {configured.render}%. Observed over actual
          gateway traffic: AWS {observed.awsPercent ?? 0}% / Render {observed.renderPercent ?? 0}% ({fmt(observed.aws)}{' '}
          AWS, {fmt(observed.render)} Render requests).
        </p>
      </div>
    </Panel>
  );
}

function TrafficPanel({ snapshot }) {
  const routing = snapshot?.routing || {};
  const configured = routing.configured || { aws: 70, render: 30 };
  const observed = routing.observed || {};
  const [awsWeight, setAwsWeight] = useState(configured.aws);
  const [renderWeight, setRenderWeight] = useState(configured.render);
  const [adminToken, setAdminToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setAwsWeight(configured.aws);
    setRenderWeight(configured.render);
  }, [configured.aws, configured.render]);

  const configData = [
    { name: 'AWS', value: configured.aws },
    { name: 'Render', value: configured.render }
  ];
  const observedData = [
    { name: 'AWS', value: observed.aws || 0 },
    { name: 'Render', value: observed.render || 0 }
  ];
  const gatewayTargets = routing.gateway?.targets || [];
  const targets = (routing.targets || []).map((target) => {
    const gateway = gatewayTargets.find((item) => item.id === target.id);
    return {
      ...target,
      observedRequests: gateway?.metrics?.requests || 0,
      observedErrors: gateway?.metrics?.errors || 0,
      p95: gateway?.metrics?.latency?.p95Ms || 0,
      breakerState: gateway?.breaker?.state || target.breakerState || 'unknown'
    };
  });

  async function submitWeights(event) {
    event.preventDefault();
    setMessage(null);
    if (Number(awsWeight) + Number(renderWeight) !== 100) {
      setMessage({ type: 'error', text: 'AWS + Render must equal 100.' });
      return;
    }
    if (!adminToken) {
      setMessage({ type: 'error', text: 'Enter the Control Plane admin token to update weights.' });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/routing/book/weights', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': adminToken
        },
        body: JSON.stringify({ aws: Number(awsWeight), render: Number(renderWeight) })
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error?.message || `HTTP ${response.status}`);
      }
      setMessage({ type: 'success', text: `Weights updated to AWS ${json.data.book.aws}% / Render ${json.data.book.render}%.` });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Traffic distribution"
      subtitle="Configured weights and observed traffic are shown separately. Observed values come from real gateway requests."
    >
      <div className="chart-grid two">
        <div>
          <h3 className="subheading">Configured</h3>
          <ResponsiveContainer width="100%" height={190}>
            <PieChart>
              <Pie data={configData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={76} paddingAngle={3}>
                <Cell fill={CLOUD_COLORS.aws} />
                <Cell fill={CLOUD_COLORS.render} />
              </Pie>
              <Tooltip formatter={(value) => `${value}%`} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
          <div className="legend-row">
            <span className="aws-text">AWS {configured.aws}%</span>
            <span className="render-text">Render {configured.render}%</span>
          </div>
        </div>
        <div>
          <h3 className="subheading">Observed</h3>
          {(observed.aws || 0) + (observed.render || 0) === 0 ? (
            <div className="empty-state">No observed traffic yet. Send real requests through the gateway.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={190}>
                <PieChart>
                  <Pie data={observedData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={76} paddingAngle={3}>
                    <Cell fill={CLOUD_COLORS.aws} />
                    <Cell fill={CLOUD_COLORS.render} />
                  </Pie>
                  <Tooltip formatter={(value) => `${fmt(value)} requests`} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
              <div className="legend-row">
                <span className="aws-text">AWS {observed.awsPercent ?? 0}%</span>
                <span className="render-text">Render {observed.renderPercent ?? 0}%</span>
              </div>
            </>
          )}
        </div>
      </div>

      <form className="weight-form" onSubmit={submitWeights}>
        <label>
          AWS weight
          <input
            type="number"
            min="0"
            max="100"
            value={awsWeight}
            onChange={(event) => setAwsWeight(event.target.value)}
          />
        </label>
        <label>
          Render weight
          <input
            type="number"
            min="0"
            max="100"
            value={renderWeight}
            onChange={(event) => setRenderWeight(event.target.value)}
          />
        </label>
        <label className="grow">
          Control Plane admin token
          <input
            type="password"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            placeholder="Enter admin token (never stored)"
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Updating…' : 'Update weights'}
        </button>
      </form>
      {message ? <div className={`inline-message ${message.type}`}>{message.text}</div> : null}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Cloud</th>
              <th>Configured</th>
              <th>Status</th>
              <th>Requests</th>
              <th>Errors</th>
              <th>P95</th>
              <th>Breaker</th>
              <th>Endpoint</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => (
              <tr key={target.id}>
                <td>{target.id}</td>
                <td>
                  <span className={`cloud-chip ${target.cloud}`}>{target.cloud}</span>
                </td>
                <td>{target.weight}%</td>
                <td>
                  <StatusPill status={target.status} />
                </td>
                <td>{fmt(target.observedRequests)}</td>
                <td>{fmt(target.observedErrors)}</td>
                <td>{ms(target.p95)}</td>
                <td>{target.breakerState}</td>
                <td className="mono small">{target.baseUrl || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="inline-stats">
        <span>Failovers: <b>{fmt(routing.gateway?.failovers ?? snapshot?.mesh?.failovers)}</b></span>
        <span>Retries: <b>{fmt(routing.gateway?.retries ?? snapshot?.mesh?.retries)}</b></span>
        <span>Routing version: <b>{routing.version ?? '—'}</b></span>
        <span>Updated by: <b>{routing.updatedBy || '—'}</b></span>
      </div>
    </Panel>
  );
}

function PerformancePanel({ snapshot, history }) {
  const mesh = snapshot?.mesh || {};
  const statusCodes = mesh.statusCodes || { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const statusData = [
    { name: '2xx', value: statusCodes['2xx'] || 0 },
    { name: '3xx', value: statusCodes['3xx'] || 0 },
    { name: '4xx', value: statusCodes['4xx'] || 0 },
    { name: '5xx', value: statusCodes['5xx'] || 0 }
  ];
  return (
    <Panel
      title="Performance monitoring"
      subtitle="Real gateway observations: throughput, latency percentiles and response classes."
    >
      <div className="mini-metrics">
        <MetricCard label="Requests / second" value={fmt(mesh.requestsPerSecond)} />
        <MetricCard label="Average latency" value={ms(mesh.avgLatencyMs)} />
        <MetricCard label="P95 latency" value={ms(mesh.p95LatencyMs)} />
        <MetricCard label="P99 latency" value={ms(mesh.p99LatencyMs)} />
        <MetricCard label="Error rate" value={pct((mesh.errorRate || 0) * 100)} />
        <MetricCard label="Total requests" value={fmt(mesh.totalRequests)} />
      </div>

      <div className="chart-grid two">
        <div>
          <h3 className="subheading">Throughput and latency over time</h3>
          {history.length < 2 ? (
            <div className="empty-state">Collecting real observations…</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={history}>
                <CartesianGrid stroke="#25324a" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: '#93a4bd', fontSize: 11 }} minTickGap={24} />
                <YAxis yAxisId="rps" tick={{ fill: '#93a4bd', fontSize: 11 }} />
                <YAxis yAxisId="ms" orientation="right" tick={{ fill: '#93a4bd', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #2b3a55' }} />
                <Legend />
                <Line yAxisId="rps" type="monotone" dataKey="rps" name="req/s" stroke="#38bdf8" dot={false} strokeWidth={2} />
                <Line yAxisId="ms" type="monotone" dataKey="p95" name="P95 ms" stroke="#f59e0b" dot={false} strokeWidth={2} />
                <Line yAxisId="ms" type="monotone" dataKey="p99" name="P99 ms" stroke="#ef4444" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <div>
          <h3 className="subheading">HTTP response classes</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={statusData}>
              <CartesianGrid stroke="#25324a" strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fill: '#93a4bd', fontSize: 12 }} />
              <YAxis tick={{ fill: '#93a4bd', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #2b3a55' }} />
              <Bar dataKey="value" name="responses" radius={[4, 4, 0, 0]}>
                {statusData.map((entry) => (
                  <Cell key={entry.name} fill={entry.name === '5xx' ? '#ef4444' : entry.name === '4xx' ? '#f59e0b' : '#22c55e'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Panel>
  );
}

function ServicesPanel({ snapshot, connected }) {
  const byId = useMemo(
    () => Object.fromEntries((snapshot?.components || []).map((component) => [component.id, component])),
    [snapshot]
  );
  const expected = snapshot?.expected || [];
  const rows = [
    ['book-service', 'service', 'AWS'],
    ['book-primary-sidecar', 'sidecar', 'AWS'],
    ['borrow-service', 'service', 'AWS'],
    ['borrow-sidecar', 'sidecar', 'AWS'],
    ['notification-service', 'service', 'AWS'],
    ['notification-sidecar', 'sidecar', 'AWS'],
    ['book-replica-service', 'service', 'Render'],
    ['book-replica-sidecar', 'sidecar', 'Render'],
    ['member-service', 'service', 'Render'],
    ['member-sidecar', 'sidecar', 'Render']
  ];

  return (
    <Panel
      title="Service and sidecar health"
      subtitle="Every row is backed by a real heartbeat. Missing or stale components are never shown as healthy."
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th>Kind</th>
              <th>Cloud</th>
              <th>Status</th>
              <th>Last heartbeat</th>
              <th>Uptime</th>
              <th>Requests</th>
              <th>Errors</th>
              <th>Avg latency</th>
              <th>Process / breaker</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, kind, cloud]) => {
              const component = byId[id];
              const expectedRecord = expected.find((item) => item.id === id);
              const status = !connected ? 'unknown' : component?.status || expectedRecord?.status || 'not_registered';
              const metrics = component?.metrics || {};
              const breaker = metrics.breaker?.state || component?.meta?.breaker?.state;
              const runtime = component?.meta?.runtime || 'unknown';
              return (
                <tr key={id}>
                  <td>
                    <div className="primary-cell">{id}</div>
                    <div className="mono small">{component?.baseUrl || 'no endpoint'}</div>
                  </td>
                  <td>{kind}</td>
                  <td>
                    <span className={`cloud-chip ${cloud.toLowerCase()}`}>{cloud}</span>
                  </td>
                  <td>
                    <StatusPill status={status} />
                  </td>
                  <td>{relativeTime(component?.lastHeartbeat)}</td>
                  <td>{component?.metrics?.uptimeSeconds ? `${fmt(component.metrics.uptimeSeconds)} s` : '—'}</td>
                  <td>{fmt(metrics.requests)}</td>
                  <td>{fmt(metrics.errors)}</td>
                  <td>{ms(metrics.latency?.avgMs)}</td>
                  <td>
                    <div className="small">{runtime}</div>
                    {kind === 'sidecar' ? <div className="small">breaker: {breaker || 'unknown'}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function BreakersPanel({ snapshot }) {
  const breakers = snapshot?.circuitBreakers || [];
  return (
    <Panel
      title="Circuit breakers"
      subtitle="CLOSED → OPEN → HALF-OPEN transitions are reported by sidecars and the gateway."
    >
      {breakers.length === 0 ? (
        <div className="empty-state">No circuit breaker data reported yet.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Breaker</th>
                <th>State</th>
                <th>Failures</th>
                <th>Transitions</th>
                <th>Retry in</th>
                <th>Last transition</th>
              </tr>
            </thead>
            <tbody>
              {breakers.map((breaker, index) => (
                <tr key={`${breaker.source}-${breaker.name}-${index}`}>
                  <td>{breaker.source}</td>
                  <td className="mono small">{breaker.name}</td>
                  <td>
                    <span className={`breaker-state ${String(breaker.state).toLowerCase()}`}>{breaker.state}</span>
                  </td>
                  <td>{fmt(breaker.failures)}</td>
                  <td>{fmt(breaker.transitions)}</td>
                  <td>{breaker.state === 'OPEN' ? ms(breaker.retryInMs) : '—'}</td>
                  <td>{breaker.lastTransitionAt ? relativeTime(new Date(breaker.lastTransitionAt).toISOString()) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function CachePanel({ snapshot }) {
  const cache = snapshot?.cache || {};
  const redis = cache.redis || {};
  const metrics = cache.metrics || {};
  return (
    <Panel
      title="Redis and Cache API"
      subtitle="Redis is reached only through the authenticated Cache API. It is never the source of truth."
    >
      <div className="mini-metrics">
        <MetricCard
          label="Redis"
          value={redis.available ? 'Available' : 'Unavailable'}
          status={redis.available ? 'healthy' : 'unhealthy'}
          detail={redis.lastError || 'private port 6379'}
        />
        <MetricCard label="Cache API" value={cache.cacheApiStatus || 'unknown'} status={cache.cacheApiStatus} />
        <MetricCard label="Hits" value={fmt(metrics.hits)} />
        <MetricCard label="Misses" value={fmt(metrics.misses)} />
        <MetricCard label="Hit ratio" value={pct(metrics.hitRatio)} />
        <MetricCard label="Fallback events" value={fmt(cache.fallbackEvents)} status={cache.fallbackEvents > 0 ? 'degraded' : undefined} />
      </div>
      <div className="cache-details">
        <div>Sets: <b>{fmt(metrics.sets)}</b></div>
        <div>Deletes: <b>{fmt(metrics.deletes)}</b></div>
        <div>Errors: <b>{fmt(metrics.errors)}</b></div>
        <div>Redis latency: <b>{redis.latencyMs !== null && redis.latencyMs !== undefined ? ms(redis.latencyMs) : '—'}</b></div>
        <div>Last ping: <b>{relativeTime(redis.lastPingAt)}</b></div>
      </div>
      {!redis.available ? (
        <div className="inline-message error">
          Redis is unavailable. Read-heavy services fall back to PostgreSQL; requests continue where possible.
        </div>
      ) : null}
    </Panel>
  );
}

function AlertsAndEventsPanel({ snapshot, connected }) {
  const [severity, setSeverity] = useState('all');
  const [cloud, setCloud] = useState('all');
  const [source, setSource] = useState('');
  const [type, setType] = useState('');
  const [windowMinutes, setWindowMinutes] = useState('all');
  const alerts = snapshot?.alerts || [];
  const events = snapshot?.events || [];
  const filtered = events.filter((event) => {
    if (severity !== 'all' && event.severity !== severity) return false;
    if (cloud !== 'all' && event.cloud !== cloud) return false;
    if (source && !String(event.source).toLowerCase().includes(source.toLowerCase())) return false;
    if (type && !String(event.type).toLowerCase().includes(type.toLowerCase())) return false;
    if (windowMinutes !== 'all') {
      const cutoff = Date.now() - Number(windowMinutes) * 60000;
      if (Date.parse(event.ts) < cutoff) return false;
    }
    return true;
  });

  return (
    <Panel
      title="Alerts, events and logs"
      subtitle="Actual Control Plane events: registrations, health changes, weights, failovers, breakers, Redis failures, auth failures and Render process restarts."
    >
      <div className="alerts-list">
        {!connected ? (
          <div className="alert-row error">
            <span className="alert-severity">error</span>
            <span>Dashboard is disconnected from the Control Plane. Values below are last known, not live.</span>
          </div>
        ) : null}
        {alerts.length === 0 && connected ? (
          <div className="empty-state compact">No active alerts.</div>
        ) : (
          alerts.map((alert) => (
            <div key={alert.id} className={`alert-row ${alert.severity}`}>
              <span className="alert-severity">{alert.severity}</span>
              <span>{alert.message}</span>
            </div>
          ))
        )}
      </div>

      <div className="filters">
        <label>
          Severity
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label>
          Cloud
          <select value={cloud} onChange={(event) => setCloud(event.target.value)}>
            <option value="all">All</option>
            <option value="aws">AWS</option>
            <option value="render">Render</option>
          </select>
        </label>
        <label>
          Source
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="e.g. book-service" />
        </label>
        <label>
          Type
          <input value={type} onChange={(event) => setType(event.target.value)} placeholder="e.g. circuit" />
        </label>
        <label>
          Time
          <select value={windowMinutes} onChange={(event) => setWindowMinutes(event.target.value)}>
            <option value="all">All retained</option>
            <option value="5">Last 5 minutes</option>
            <option value="15">Last 15 minutes</option>
            <option value="60">Last hour</option>
          </select>
        </label>
      </div>

      <div className="event-list">
        {filtered.length === 0 ? (
          <div className="empty-state">No events match the current filters.</div>
        ) : (
          filtered.slice(0, 100).map((event) => (
            <div key={event.id} className={`event-row severity-${event.severity}`}>
              <div className="event-time">{new Date(event.ts).toLocaleTimeString()}</div>
              <div className={`event-severity ${event.severity}`}>{event.severity}</div>
              <div className="event-main">
                <div className="event-title">
                  <b>{event.source}</b> <span className="mono small">{event.type}</span>
                </div>
                <div>{event.message}</div>
                {event.details && Object.keys(event.details).length > 0 ? (
                  <details>
                    <summary>details</summary>
                    <pre>{JSON.stringify(event.details, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
              <div className={`cloud-chip ${event.cloud}`}>{event.cloud}</div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function RenderPanel({ snapshot }) {
  const render = snapshot?.render || {};
  const processes = render.processes || [];
  return (
    <Panel
      title="Render process supervision"
      subtitle="Four application/sidecar processes plus the ingress dispatcher in ONE Render Free web service."
    >
      {snapshot?.mode !== 'bundle' ? (
        <div className="inline-message info">
          Local split mode is active. The Render components currently run as separate containers for development.
          Start the <code>bundle</code> profile to exercise the single-container supervisor and ingress dispatcher.
        </div>
      ) : null}
      <div className="render-summary">
        <div>Mode: <b>{snapshot?.mode || 'unknown'}</b></div>
        <div>Supervisor: <b>{render.supervisor?.status || 'unknown'}</b></div>
        <div>Ingress: <b>{render.ingress?.status || 'unknown'}</b></div>
      </div>
      {processes.length === 0 ? (
        <div className="empty-state">No supervised Render process data reported yet.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Process</th>
                <th>State</th>
                <th>PID</th>
                <th>Restarts</th>
                <th>Started</th>
                <th>Last exit</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((process) => (
                <tr key={process.name}>
                  <td className="primary-cell">{process.name}</td>
                  <td>
                    <span className={`breaker-state ${process.state === 'running' ? 'closed' : 'open'}`}>
                      {process.state}
                    </span>
                  </td>
                  <td>{process.pid || '—'}</td>
                  <td>{fmt(process.restarts)}</td>
                  <td>{relativeTime(process.startedAt)}</td>
                  <td>
                    {process.lastExit
                      ? `${process.lastExit.code ?? process.lastExit.signal} · ${relativeTime(process.lastExit.at)}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Process-level supervision restarts failed processes, but it does not provide the same isolation as
        separate containers. Locally and on AWS EC2, services and sidecars use separate containers.
      </p>
    </Panel>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [connected, setConnected] = useState(true);
  const [lastError, setLastError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/mesh/status', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Control Plane returned HTTP ${response.status}`);
        const json = await response.json();
        if (!json?.data) throw new Error('Malformed Control Plane response');
        if (cancelled) return;
        setSnapshot(json.data);
        setConnected(true);
        setLastError(null);
        setLastUpdated(new Date());
        const mesh = json.data.mesh || {};
        setHistory((previous) =>
          [
            ...previous,
            {
              time: Date.now(),
              label: new Date().toLocaleTimeString(),
              rps: mesh.requestsPerSecond || 0,
              p95: mesh.p95LatencyMs || 0,
              p99: mesh.p99LatencyMs || 0,
              requests: mesh.totalRequests || 0,
              errors: mesh.errors || 0
            }
          ].slice(-60)
        );
      } catch (error) {
        if (cancelled) return;
        setConnected(false);
        setLastError(error.message);
      }
    }
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const mesh = snapshot?.mesh || {};
  const effectiveStatus = connected ? mesh.status || 'unknown' : 'unknown';
  const redis = snapshot?.cache?.redis || {};

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">Multi-Cloud Service Mesh · Data Plane Sidecar</div>
          <h1>Live Control Room</h1>
          <p className="header-subtitle">
            AWS Academy EC2 + Render Free · real heartbeats, real traffic, real failure states
          </p>
        </div>
        <div className="header-status">
          <StatusPill status={effectiveStatus} />
          <div className={`live-indicator ${connected ? 'online' : 'offline'}`}>
            <span className="live-dot" />
            {connected ? 'Live polling every 2s' : 'Disconnected'}
          </div>
          <div className="timestamp">Last update: {lastUpdated ? lastUpdated.toLocaleTimeString() : 'waiting…'}</div>
        </div>
      </header>

      {!connected ? (
        <div className="banner error">
          <b>Control Plane disconnected.</b> {lastError || 'No response from the dashboard backend.'} The values
          below are the last known snapshot and are not presented as live or healthy.
        </div>
      ) : null}

      <div className="metric-grid overview">
        <MetricCard
          label="Overall mesh health"
          value={statusLabel(effectiveStatus)}
          status={effectiveStatus}
          detail={`${mesh.healthy || 0} healthy · ${mesh.degraded || 0} degraded · ${mesh.unhealthy || 0} unhealthy · ${mesh.unknown || 0} unknown`}
        />
        <MetricCard
          label="Registered"
          value={`${fmt(mesh.registeredServices)} / ${fmt(mesh.registeredSidecars)}`}
          detail="services / sidecars"
        />
        <MetricCard label="Total requests" value={fmt(mesh.totalRequests)} detail="observed at the gateway" />
        <MetricCard label="Error rate" value={pct((mesh.errorRate || 0) * 100)} status={(mesh.errorRate || 0) > 0.1 ? 'unhealthy' : undefined} />
        <MetricCard label="Average latency" value={ms(mesh.avgLatencyMs)} detail={`P95 ${ms(mesh.p95LatencyMs)} · P99 ${ms(mesh.p99LatencyMs)}`} />
        <MetricCard
          label="Redis"
          value={redis.available ? 'Available' : 'Unavailable'}
          status={redis.available ? 'healthy' : 'unhealthy'}
          detail={`${fmt(snapshot?.cache?.metrics?.hits)} hits · ${fmt(snapshot?.cache?.metrics?.misses)} misses`}
        />
        <MetricCard
          label="Missing / disconnected"
          value={fmt((mesh.unknown || 0) + (mesh.notRegistered || 0))}
          status={(mesh.unknown || 0) + (mesh.notRegistered || 0) > 0 ? 'unknown' : undefined}
          detail={`${mesh.expectedComponents || 0} expected components`}
        />
      </div>

      <Topology snapshot={snapshot} connected={connected} />

      <div className="two-column">
        <TrafficPanel snapshot={snapshot} />
        <CachePanel snapshot={snapshot} />
      </div>

      <PerformancePanel snapshot={snapshot} history={history} />

      <ServicesPanel snapshot={snapshot} connected={connected} />

      <div className="two-column">
        <BreakersPanel snapshot={snapshot} />
        <RenderPanel snapshot={snapshot} />
      </div>

      <AlertsAndEventsPanel snapshot={snapshot} connected={connected} />

      <footer className="app-footer">
        <p>
          Every number on this page is derived from real backend metrics and Control Plane events. No random,
          synthetic or fake values are used. Components that stop heartbeating are displayed as Unknown /
          Disconnected, never as healthy.
        </p>
        <p>
          Security note: Render public HTTPS terminates TLS at Render's edge. Cross-cloud requests use
          application-level HMAC authentication. Ordinary Render HTTPS is not end-to-end sidecar mTLS.
        </p>
      </footer>
    </div>
  );
}
