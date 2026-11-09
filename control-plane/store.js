'use strict';

const { logger } = require('@mesh/shared');

const VALID_STATUSES = new Set(['healthy', 'degraded', 'unhealthy', 'unknown']);
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'critical']);
const VALID_KINDS = new Set([
  'service',
  'sidecar',
  'gateway',
  'cache',
  'supervisor',
  'ingress',
  'control-plane',
  'dashboard'
]);

const COMMON_EXPECTED = [
  'book-service',
  'book-primary-sidecar',
  'borrow-service',
  'borrow-sidecar',
  'notification-service',
  'notification-sidecar',
  'api-gateway',
  'cache-api'
];
const SPLIT_EXPECTED = [
  'book-replica-service',
  'book-replica-sidecar',
  'member-service',
  'member-sidecar'
];
const BUNDLE_EXPECTED = ['render-supervisor', 'render-ingress'];

function normalizeStatus(value) {
  return VALID_STATUSES.has(value) ? value : 'unknown';
}

function expectedComponents(mode) {
  if (mode === 'bundle') return [...COMMON_EXPECTED, ...SPLIT_EXPECTED, ...BUNDLE_EXPECTED];
  return [...COMMON_EXPECTED, ...SPLIT_EXPECTED];
}

class MeshStore {
  constructor({ pool = null, staleMs = 12000, mode = 'split', log = logger.child('control-plane') } = {}) {
    this.pool = pool;
    this.staleMs = staleMs;
    this.mode = mode;
    this.log = log;
    this.components = new Map();
    this.events = [];
    this.eventSequence = 0;
    this.routing = {
      version: 1,
      book: { aws: 70, render: 30 },
      updatedAt: new Date().toISOString(),
      updatedBy: 'initial-policy'
    };
    this.dbConnected = false;
    this.lastDbError = null;
    this.startedAt = new Date().toISOString();
    this.expected = expectedComponents(mode);
  }

  async initializeDatabase() {
    if (!this.pool) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS mesh_events (
          id BIGSERIAL PRIMARY KEY,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          severity TEXT NOT NULL,
          source TEXT NOT NULL,
          cloud TEXT,
          type TEXT NOT NULL,
          message TEXT NOT NULL,
          details JSONB
        );
        CREATE TABLE IF NOT EXISTS mesh_routing_policy (
          id INTEGER PRIMARY KEY,
          aws_weight INTEGER NOT NULL,
          render_weight INTEGER NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT
        );
      `);
      await this.pool.query(
        `INSERT INTO mesh_routing_policy (id, aws_weight, render_weight, updated_by)
         VALUES (1, 70, 30, 'initial-policy')
         ON CONFLICT (id) DO NOTHING`
      );
      const policy = await this.pool.query(
        'SELECT aws_weight, render_weight, updated_at, updated_by FROM mesh_routing_policy WHERE id = 1'
      );
      if (policy.rows.length > 0) {
        const row = policy.rows[0];
        this.routing = {
          version: 1,
          book: { aws: row.aws_weight, render: row.render_weight },
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
          updatedBy: row.updated_by || 'database'
        };
      }
      const recent = await this.pool.query(
        `SELECT id, ts, severity, source, cloud, type, message, details
         FROM mesh_events ORDER BY id DESC LIMIT 200`
      );
      this.events = recent.rows
        .map((row) => ({
          id: Number(row.id),
          ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
          severity: row.severity,
          source: row.source,
          cloud: row.cloud,
          type: row.type,
          message: row.message,
          details: row.details || {}
        }))
        .reverse();
      this.eventSequence = this.events.reduce((max, event) => Math.max(max, event.id), 0);
      this.dbConnected = true;
      this.lastDbError = null;
      this.log.info('database_ready', { persistedEvents: this.events.length });
    } catch (error) {
      this.dbConnected = false;
      this.lastDbError = error.message;
      this.log.warn('database_unavailable_memory_mode', { message: error.message });
    }
  }

  recordEvent({ severity = 'info', source = 'control-plane', cloud = 'aws', type, message, details = {}, persist = true }) {
    const normalizedSeverity = VALID_SEVERITIES.has(severity) ? severity : 'info';
    const event = {
      id: ++this.eventSequence,
      ts: new Date().toISOString(),
      severity: normalizedSeverity,
      source,
      cloud,
      type: type || 'generic_event',
      message: message || '',
      details
    };
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
    if (persist && this.pool && this.dbConnected) {
      this.pool
        .query(
          `INSERT INTO mesh_events (severity, source, cloud, type, message, details)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [event.severity, event.source, event.cloud, event.type, event.message, JSON.stringify(details)]
        )
        .catch((error) => {
          this.dbConnected = false;
          this.lastDbError = error.message;
        });
    }
    return event;
  }

  getEvents({ severity, source, cloud, type, since, limit = 200 } = {}) {
    const sinceMs = since ? Date.parse(since) : null;
    return this.events
      .filter((event) => {
        if (severity && event.severity !== severity) return false;
        if (source && event.source !== source) return false;
        if (cloud && event.cloud !== cloud) return false;
        if (type && event.type !== type) return false;
        if (sinceMs && Number.isFinite(sinceMs) && Date.parse(event.ts) < sinceMs) return false;
        return true;
      })
      .slice(-Math.min(1000, Math.max(1, Number(limit) || 200)))
      .reverse();
  }

  register(payload) {
    const now = Date.now();
    const existing = this.components.get(payload.id);
    const kind = VALID_KINDS.has(payload.kind) ? payload.kind : 'service';
    const status = normalizeStatus(payload.status || 'healthy');
    const record = existing || {
      id: payload.id,
      firstRegisteredAt: new Date(now).toISOString(),
      effectiveStatus: 'unknown',
      reportedStatus: 'unknown',
      disconnected: false,
      configVersion: null,
      metrics: {},
      meta: {},
      events: []
    };
    Object.assign(record, {
      name: payload.name || record.name || payload.id,
      kind,
      cloud: payload.cloud || record.cloud || 'aws',
      role: payload.role || record.role || 'service',
      baseUrl: payload.baseUrl || record.baseUrl || null,
      version: payload.version || record.version || '1.0.0',
      startedAt: payload.startedAt || record.startedAt || new Date(now).toISOString(),
      meta: { ...(record.meta || {}), ...(payload.meta || {}) },
      lastHeartbeat: now,
      lastHeartbeatAt: new Date(now).toISOString(),
      reportedStatus: status,
      effectiveStatus: status,
      disconnected: false,
      registered: true
    });
    this.components.set(record.id, record);
    if (!existing) {
      this.recordEvent({
        severity: 'info',
        source: record.id,
        cloud: record.cloud,
        type: 'service_registered',
        message: `${record.name} registered with the Control Plane`,
        details: { kind: record.kind, role: record.role, baseUrl: record.baseUrl }
      });
    } else if (existing.disconnected) {
      this.recordEvent({
        severity: 'info',
        source: record.id,
        cloud: record.cloud,
        type: 'component_reconnected',
        message: `${record.name} reconnected to the Control Plane`,
        details: { status }
      });
    }
    return record;
  }

  heartbeat(payload) {
    const record = this.components.get(payload.id);
    if (!record) return null;
    const now = Date.now();
    const previousEffective = record.effectiveStatus;
    const status = normalizeStatus(payload.status);
    const wasDisconnected = record.disconnected;

    record.lastHeartbeat = now;
    record.lastHeartbeatAt = new Date(now).toISOString();
    record.reportedStatus = status;
    record.effectiveStatus = status;
    record.metrics = payload.metrics || {};
    record.meta = { ...(record.meta || {}), ...(payload.meta || {}) };
    record.configVersion = payload.configVersion !== undefined ? payload.configVersion : record.configVersion;
    record.disconnected = false;

    if (wasDisconnected) {
      this.recordEvent({
        severity: 'info',
        source: record.id,
        cloud: record.cloud,
        type: 'component_recovered',
        message: `${record.name} resumed heartbeats`,
        details: { status }
      });
    } else if (previousEffective !== 'unknown' && previousEffective !== status) {
      const severity = status === 'unhealthy' ? 'error' : status === 'degraded' ? 'warn' : 'info';
      this.recordEvent({
        severity,
        source: record.id,
        cloud: record.cloud,
        type: 'health_status_change',
        message: `${record.name} health changed from ${previousEffective} to ${status}`,
        details: { previous: previousEffective, current: status }
      });
    }
    return record;
  }

  deregister(id, reason = 'deregistered') {
    const record = this.components.get(id);
    if (!record) return false;
    this.components.delete(id);
    this.recordEvent({
      severity: 'warn',
      source: id,
      cloud: record.cloud,
      type: 'service_deregistered',
      message: `${record.name} deregistered (${reason})`,
      details: { reason }
    });
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const record of this.components.values()) {
      if (!record.disconnected && now - record.lastHeartbeat > this.staleMs) {
        record.disconnected = true;
        record.effectiveStatus = 'unknown';
        this.recordEvent({
          severity: 'error',
          source: record.id,
          cloud: record.cloud,
          type: 'component_disconnected',
          message: `${record.name} stopped sending heartbeats and is now Unknown/Disconnected`,
          details: { lastHeartbeatAt: record.lastHeartbeatAt, staleAfterMs: this.staleMs }
        });
      }
    }
  }

  getComponent(id) {
    return this.components.get(id) || null;
  }

  listComponents({ kind, cloud, name } = {}) {
    return [...this.components.values()]
      .filter((record) => {
        if (kind && record.kind !== kind) return false;
        if (cloud && record.cloud !== cloud) return false;
        if (name && record.id !== name && record.name !== name) return false;
        return true;
      })
      .map((record) => this.publicComponent(record))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  publicComponent(record) {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      cloud: record.cloud,
      role: record.role,
      baseUrl: record.baseUrl,
      version: record.version,
      status: record.effectiveStatus,
      reportedStatus: record.reportedStatus,
      disconnected: record.disconnected,
      stale: record.disconnected,
      lastHeartbeat: record.lastHeartbeatAt,
      firstRegisteredAt: record.firstRegisteredAt,
      startedAt: record.startedAt,
      configVersion: record.configVersion,
      metrics: record.metrics,
      meta: record.meta
    };
  }

  setBookWeights(aws, render, updatedBy) {
    if (!Number.isInteger(aws) || !Number.isInteger(render)) {
      return { ok: false, reason: 'weights_must_be_integers' };
    }
    if (aws < 0 || render < 0 || aws > 100 || render > 100) {
      return { ok: false, reason: 'weights_out_of_range' };
    }
    if (aws + render !== 100) {
      return { ok: false, reason: 'weights_must_total_100' };
    }
    const previous = { ...this.routing.book };
    this.routing = {
      version: this.routing.version + 1,
      book: { aws, render },
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy || 'admin'
    };
    this.recordEvent({
      severity: 'info',
      source: 'control-plane',
      cloud: 'aws',
      type: 'traffic_weight_change',
      message: `Book traffic weights changed from ${previous.aws}:${previous.render} to ${aws}:${render}`,
      details: { previous, current: { aws, render }, updatedBy: updatedBy || 'admin' }
    });
    if (this.pool && this.dbConnected) {
      this.pool
        .query(
          `UPDATE mesh_routing_policy
           SET aws_weight = $1, render_weight = $2, updated_at = NOW(), updated_by = $3
           WHERE id = 1`,
          [aws, render, updatedBy || 'admin']
        )
        .catch((error) => {
          this.dbConnected = false;
          this.lastDbError = error.message;
        });
    }
    return { ok: true, routing: this.routing };
  }

  getBookRouting() {
    const targets = [
      { id: 'book-primary-sidecar', cloud: 'aws', weightKey: 'aws' },
      { id: 'book-replica-sidecar', cloud: 'render', weightKey: 'render' }
    ].map((target) => {
      const record = this.components.get(target.id);
      return {
        id: target.id,
        cloud: target.cloud,
        weight: this.routing.book[target.weightKey],
        baseUrl: record ? record.baseUrl : null,
        status: record ? record.effectiveStatus : 'not_registered',
        reportedStatus: record ? record.reportedStatus : 'unknown',
        lastHeartbeat: record ? record.lastHeartbeatAt : null,
        upstream: record ? record.meta && record.meta.upstream : null,
        routable: Boolean(record && record.baseUrl && ['healthy', 'degraded'].includes(record.effectiveStatus))
      };
    });
    return {
      version: this.routing.version,
      policy: { ...this.routing.book },
      updatedAt: this.routing.updatedAt,
      updatedBy: this.routing.updatedBy,
      targets
    };
  }

  expectedStatuses() {
    return this.expected.map((id) => {
      const record = this.components.get(id);
      if (!record) {
        return { id, status: 'not_registered', registered: false };
      }
      return {
        id,
        status: record.effectiveStatus,
        registered: true,
        disconnected: record.disconnected
      };
    });
  }

  buildStatus({ controlPlaneMetrics = {}, gateway = null } = {}) {
    const components = this.listComponents();
    const expected = this.expectedStatuses();
    const expectedMap = new Map(expected.map((item) => [item.id, item]));
    const counts = {
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      unknown: 0,
      notRegistered: 0
    };
    for (const item of expected) {
      if (item.status === 'not_registered') counts.notRegistered += 1;
      else if (item.status === 'unknown') counts.unknown += 1;
      else if (item.status === 'unhealthy') counts.unhealthy += 1;
      else if (item.status === 'degraded') counts.degraded += 1;
      else counts.healthy += 1;
    }

    const controlPlaneComponent = {
      id: 'control-plane',
      name: 'Control Plane - AWS',
      kind: 'control-plane',
      cloud: 'aws',
      role: 'control-plane',
      baseUrl: null,
      status: 'healthy',
      reportedStatus: 'healthy',
      disconnected: false,
      stale: false,
      lastHeartbeat: new Date().toISOString(),
      startedAt: this.startedAt,
      metrics: controlPlaneMetrics,
      meta: { databaseConnected: this.dbConnected, mode: this.mode, expectedComponents: this.expected.length }
    };

    const allComponents = [...components.filter((item) => item.id !== 'control-plane'), controlPlaneComponent];
    const gatewayRecord = gateway || this.components.get('api-gateway');
    const gatewayMetrics = gatewayRecord && gatewayRecord.metrics ? gatewayRecord.metrics : {};
    const gatewayMeta = gatewayRecord && gatewayRecord.meta ? gatewayRecord.meta : {};
    const cacheRecord = this.components.get('cache-api');
    const cacheMetrics = cacheRecord && cacheRecord.metrics ? cacheRecord.metrics : {};
    const cacheMeta = cacheRecord && cacheRecord.meta ? cacheRecord.meta : {};
    const supervisor = this.components.get('render-supervisor');
    const ingress = this.components.get('render-ingress');

    const registeredServices = components.filter((item) => item.kind === 'service').length;
    const registeredSidecars = components.filter((item) => item.kind === 'sidecar').length;

    const routing = this.getBookRouting();
    const observed = gatewayMeta.routing && gatewayMeta.routing.observed
      ? gatewayMeta.routing.observed
      : { aws: 0, render: 0 };
    const configured = routing.policy;
    const totalObserved = Number(observed.aws || 0) + Number(observed.render || 0);

    const breakers = [];
    for (const component of allComponents) {
      const breaker = component.metrics && component.metrics.breaker;
      if (breaker) {
        breakers.push({ source: component.id, cloud: component.cloud, ...breaker });
      }
      const metaBreakers = component.meta && component.meta.breakers;
      if (Array.isArray(metaBreakers)) {
        for (const item of metaBreakers) {
          breakers.push({ source: component.id, cloud: component.cloud, ...item });
        }
      }
    }

    const alerts = [];
    for (const item of expected) {
      if (item.status === 'not_registered') {
        alerts.push({
          id: `missing:${item.id}`,
          severity: 'error',
          type: 'component_not_registered',
          source: item.id,
          message: `${item.id} is not registered`,
          since: null
        });
      } else if (item.status === 'unknown') {
        alerts.push({
          id: `unknown:${item.id}`,
          severity: 'error',
          type: 'component_disconnected',
          source: item.id,
          message: `${item.id} is Unknown/Disconnected (heartbeat stale)`,
          since: null
        });
      } else if (item.status === 'unhealthy') {
        alerts.push({
          id: `unhealthy:${item.id}`,
          severity: 'error',
          type: 'component_unhealthy',
          source: item.id,
          message: `${item.id} reports an unhealthy state`,
          since: null
        });
      } else if (item.status === 'degraded') {
        alerts.push({
          id: `degraded:${item.id}`,
          severity: 'warn',
          type: 'component_degraded',
          source: item.id,
          message: `${item.id} is degraded`,
          since: null
        });
      }
    }

    if (cacheMeta.redis && cacheMeta.redis.available === false) {
      alerts.push({
        id: 'redis:unavailable',
        severity: 'error',
        type: 'redis_unavailable',
        source: 'cache-api',
        message: 'Redis is unavailable. Consumers must fall back to PostgreSQL.',
        since: cacheMeta.redis.lastErrorAt || null
      });
    }

    for (const breaker of breakers) {
      if (breaker.state === 'OPEN') {
        alerts.push({
          id: `breaker:${breaker.source}:${breaker.name}`,
          severity: 'warn',
          type: 'circuit_breaker_open',
          source: breaker.source,
          message: `Circuit breaker ${breaker.name} is OPEN`,
          since: breaker.lastTransitionAt ? new Date(breaker.lastTransitionAt).toISOString() : null
        });
      }
    }

    const gatewayRequests = Number(gatewayMetrics.requests || 0);
    const gatewayErrors = Number(gatewayMetrics.errors || 0);
    const gatewayErrorRate = gatewayRequests > 0 ? gatewayErrors / gatewayRequests : 0;
    if (gatewayRequests >= 20 && gatewayErrorRate > 0.1) {
      alerts.push({
        id: 'gateway:error_rate',
        severity: 'error',
        type: 'high_error_rate',
        source: 'api-gateway',
        message: `Gateway error rate is ${(gatewayErrorRate * 100).toFixed(1)}%`,
        since: null
      });
    }
    const p95 = gatewayMetrics.latency ? Number(gatewayMetrics.latency.p95Ms || 0) : 0;
    if (gatewayRequests >= 20 && p95 > 1000) {
      alerts.push({
        id: 'gateway:latency',
        severity: 'warn',
        type: 'high_latency',
        source: 'api-gateway',
        message: `Gateway P95 latency is ${p95} ms`,
        since: null
      });
    }

    const recentFallback = this.events
      .slice(-200)
      .some(
        (event) =>
          event.type === 'cache_fallback' &&
          Date.now() - Date.parse(event.ts) < 5 * 60 * 1000
      );
    if (recentFallback) {
      alerts.push({
        id: 'cache:fallback',
        severity: 'warn',
        type: 'cache_fallback',
        source: 'cache-api',
        message: 'Recent cache fallback events were recorded',
        since: null
      });
    }

    let meshStatus = 'healthy';
    if (counts.unhealthy > 0 || counts.unknown > 0 || counts.notRegistered > 0) meshStatus = 'degraded';
    if (gatewayRecord && gatewayRecord.effectiveStatus === 'unknown') meshStatus = 'critical';
    if (expectedMap.has('cache-api') && expectedMap.get('cache-api').status === 'unknown') meshStatus = 'critical';

    const renderProcesses = supervisor && supervisor.meta && Array.isArray(supervisor.meta.processes)
      ? supervisor.meta.processes
      : [];

    return {
      generatedAt: new Date().toISOString(),
      mode: this.mode,
      mesh: {
        status: meshStatus,
        expectedComponents: this.expected.length,
        registeredServices,
        registeredSidecars,
        registeredComponents: components.length,
        healthy: counts.healthy,
        degraded: counts.degraded,
        unhealthy: counts.unhealthy,
        unknown: counts.unknown,
        notRegistered: counts.notRegistered,
        totalRequests: gatewayRequests,
        errors: gatewayErrors,
        errorRate: gatewayRequests > 0 ? Math.round(gatewayErrorRate * 10000) / 10000 : 0,
        avgLatencyMs: gatewayMetrics.latency ? gatewayMetrics.latency.avgMs : 0,
        p95LatencyMs: p95,
        p99LatencyMs: gatewayMetrics.latency ? gatewayMetrics.latency.p99Ms : 0,
        requestsPerSecond: gatewayMetrics.requestsPerSecond || 0,
        statusCodes: gatewayMetrics.statusCodes || { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
        failovers: gatewayMeta.routing ? gatewayMeta.routing.failovers || 0 : 0,
        retries: gatewayMeta.routing ? gatewayMeta.routing.retries || 0 : 0,
        databaseConnected: this.dbConnected,
        controlPlaneStartedAt: this.startedAt
      },
      routing: {
        configured,
        observed: {
          aws: Number(observed.aws || 0),
          render: Number(observed.render || 0),
          awsPercent: totalObserved > 0 ? Math.round((Number(observed.aws || 0) / totalObserved) * 10000) / 100 : 0,
          renderPercent: totalObserved > 0 ? Math.round((Number(observed.render || 0) / totalObserved) * 10000) / 100 : 0
        },
        version: routing.version,
        updatedAt: routing.updatedAt,
        updatedBy: routing.updatedBy,
        targets: routing.targets,
        gateway: gatewayMeta.routing || null
      },
      cache: {
        cacheApiStatus: cacheRecord ? cacheRecord.effectiveStatus : 'not_registered',
        redis: cacheMeta.redis || { available: false, connected: false, status: 'unknown' },
        metrics: {
          hits: cacheMetrics.counters ? cacheMetrics.counters.hits || 0 : 0,
          misses: cacheMetrics.counters ? cacheMetrics.counters.misses || 0 : 0,
          sets: cacheMetrics.counters ? cacheMetrics.counters.sets || 0 : 0,
          deletes: cacheMetrics.counters ? cacheMetrics.counters.deletes || 0 : 0,
          errors: cacheMetrics.counters ? cacheMetrics.counters.errors || 0 : 0,
          hitRatio: cacheMetrics.counters && cacheMetrics.counters.hits + cacheMetrics.counters.misses > 0
            ? Math.round(
                (cacheMetrics.counters.hits / (cacheMetrics.counters.hits + cacheMetrics.counters.misses)) * 10000
              ) / 100
            : 0
        },
        fallbackEvents: this.events.filter((event) => event.type === 'cache_fallback').length
      },
      components: allComponents,
      expected,
      circuitBreakers: breakers,
      render: {
        supervisor: supervisor ? this.publicComponent(supervisor) : null,
        ingress: ingress ? this.publicComponent(ingress) : null,
        processes: renderProcesses,
        note:
          this.mode === 'bundle'
            ? 'Four application/sidecar processes run inside ONE Render Free web service under a lightweight supervisor. Process isolation is weaker than separate containers.'
            : 'Local split mode: the Render-side components run in separate containers for development. Production Render uses one container with four supervised processes.'
      },
      alerts,
      events: this.events.slice(-100).reverse(),
      database: { connected: this.dbConnected, lastError: this.lastDbError }
    };
  }
}

module.exports = { MeshStore, expectedComponents, VALID_STATUSES, VALID_SEVERITIES, VALID_KINDS };
