'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const {
  config,
  logger,
  respond,
  metrics,
  auth,
  meshAgent,
  requestId,
  securityHeaders
} = require('@mesh/shared');

const COMPONENT = 'render-supervisor';
const log = logger.child(COMPONENT);

config.requireSecrets(['CONTROL_PLANE_SERVICE_TOKEN', 'RENDER_SUPERVISOR_TOKEN'], COMPONENT);
config.requireEnv(
  ['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN', 'RENDER_SUPERVISOR_TOKEN'],
  COMPONENT
);

const ROOT = path.resolve(__dirname, '..');
const STATUS_PORT = config.intEnv('RENDER_SUPERVISOR_PORT', 5300, 1, 65535);
const SUPERVISOR_TOKEN = config.readEnv('RENDER_SUPERVISOR_TOKEN');
const PUBLIC_BASE_URL = config.optionalEnv('RENDER_PUBLIC_BASE_URL', 'http://render-web:8081').replace(/\/+$/, '');
const INGRESS_PORT = config.intEnv('PORT', config.intEnv('RENDER_INGRESS_PORT', 8081, 1, 65535), 1, 65535);

const stats = new metrics.Metrics(COMPONENT);
const processes = new Map();
const restartTimers = new Map();
let shuttingDown = false;

/**
 * The Render Free web service runs ONE container with these independent
 * processes. The four application/sidecar processes are supervised, and the
 * ingress dispatcher is also monitored and restarted. This is process-level
 * isolation, not container-level isolation.
 */
const DEFINITIONS = [
  {
    name: 'book-replica-service',
    script: 'services/book-replica-service/index.js',
    env: { BOOK_REPLICA_SERVICE_PORT: '4104' }
  },
  {
    name: 'book-replica-sidecar',
    script: 'sidecars/book-replica-sidecar/index.js',
    env: {
      BOOK_REPLICA_SIDECAR_PORT: '5104',
      // All four Render processes share one container. Docker DNS names only
      // resolve between containers, so internal traffic must use loopback.
      BOOK_REPLICA_SERVICE_URL: 'http://127.0.0.1:4104',
      BOOK_REPLICA_SIDECAR_ADVERTISE_URL: `${PUBLIC_BASE_URL}/book-replica`
    }
  },
  {
    name: 'member-service',
    script: 'services/member-service/index.js',
    env: { MEMBER_SERVICE_PORT: '4105' }
  },
  {
    name: 'member-sidecar',
    script: 'sidecars/member-sidecar/index.js',
    env: {
      MEMBER_SIDECAR_PORT: '5105',
      // Loopback because this sidecar and its service share one container.
      MEMBER_SERVICE_URL: 'http://127.0.0.1:4105',
      MEMBER_SIDECAR_ADVERTISE_URL: `${PUBLIC_BASE_URL}/member`
    }
  },
  {
    name: 'render-ingress',
    script: 'render/ingress.js',
    env: {
      PORT: String(INGRESS_PORT),
      RENDER_INGRESS_PORT: String(INGRESS_PORT),
      BOOK_REPLICA_SIDECAR_INTERNAL_URL: 'http://127.0.0.1:5104',
      MEMBER_SIDECAR_INTERNAL_URL: 'http://127.0.0.1:5105',
      RENDER_SUPERVISOR_STATUS_URL: `http://127.0.0.1:${STATUS_PORT}/status`
    }
  }
];

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  component: {
    id: COMPONENT,
    name: 'Render Process Supervisor',
    kind: 'supervisor',
    cloud: 'render',
    role: 'supervisor',
    baseUrl: `http://127.0.0.1:${STATUS_PORT}`,
    meta: {
      mode: 'one-container-four-supervised-processes-plus-ingress',
      isolation: 'process-level-only',
      statusPort: STATUS_PORT,
      ingressPort: INGRESS_PORT
    }
  },
  getStatus: () => {
    if (shuttingDown) return 'unknown';
    const running = [...processes.values()].filter((item) => item.state === 'running').length;
    return running === DEFINITIONS.length ? 'healthy' : 'degraded';
  },
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({
    processes: processList(),
    isolation: 'process-level-only',
    note:
      'Four application/sidecar processes plus the ingress dispatcher run in ONE Render Free web service container. This is not equivalent to separate-container isolation.',
    ingressPort: INGRESS_PORT
  })
});

function processList() {
  return DEFINITIONS.map((definition) => {
    const record = processes.get(definition.name);
    return record || {
      name: definition.name,
      state: 'stopped',
      pid: null,
      restarts: 0,
      startedAt: null,
      lastExit: null,
      script: definition.script
    };
  });
}

function startProcess(definition) {
  if (shuttingDown) return;
  const existing = processes.get(definition.name);
  const restarts = existing ? existing.restarts : 0;
  const child = spawn(process.execPath, [path.join(ROOT, definition.script)], {
    cwd: ROOT,
    env: { ...process.env, ...definition.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const record = {
    name: definition.name,
    state: 'running',
    pid: child.pid,
    restarts,
    startedAt: new Date().toISOString(),
    lastExit: existing ? existing.lastExit : null,
    script: definition.script
  };
  processes.set(definition.name, record);
  stats.inc('process_starts');

  child.stdout.on('data', (chunk) => process.stdout.write(`[${definition.name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${definition.name}] ${chunk}`));

  child.on('error', (error) => {
    log.error('process_spawn_error', { process: definition.name, message: error.message });
    agent.reportEvent({
      severity: 'error',
      type: 'render_process_spawn_error',
      message: `Failed to start ${definition.name}`,
      details: { process: definition.name, error: error.message }
    });
  });

  child.on('exit', (code, signal) => {
    const current = processes.get(definition.name);
    if (!current) return;
    current.state = shuttingDown ? 'stopped' : 'restarting';
    current.pid = null;
    current.lastExit = { code, signal, at: new Date().toISOString() };
    stats.inc('process_exits');

    if (shuttingDown) return;

    current.restarts += 1;
    stats.inc('process_crashes');
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(current.restarts, 5));
    log.warn('process_exited_restarting', {
      process: definition.name,
      code,
      signal,
      restarts: current.restarts,
      delayMs
    });
    agent.reportEvent({
      severity: 'error',
      type: 'render_process_crash',
      message: `${definition.name} exited and will be restarted`,
      details: { process: definition.name, code, signal, restarts: current.restarts, delayMs }
    });

    const timer = setTimeout(() => {
      restartTimers.delete(definition.name);
      if (shuttingDown) return;
      log.info('process_restarting', { process: definition.name, restarts: current.restarts });
      startProcess(definition);
      agent.reportEvent({
        severity: 'warn',
        type: 'render_process_restarted',
        message: `${definition.name} was restarted by the supervisor`,
        details: { process: definition.name, restarts: current.restarts }
      });
    }, delayMs);
    restartTimers.set(definition.name, timer);
  });

  log.info('process_started', { process: definition.name, pid: child.pid, restarts });
  agent.reportEvent({
    severity: 'info',
    type: 'render_process_started',
    message: `${definition.name} started`,
    details: { process: definition.name, pid: child.pid, restarts }
  });
}

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requestId);
app.use(express.json({ limit: '20kb' }));

app.get('/health', (req, res) => {
  const list = processList();
  const running = list.filter((item) => item.state === 'running').length;
  return respond.ok(res, {
    component: COMPONENT,
    status: running === DEFINITIONS.length ? 'healthy' : 'degraded',
    running,
    total: DEFINITIONS.length,
    processes: list
  });
});

app.get('/status', auth.requireApiKey(SUPERVISOR_TOKEN, 'x-admin-token'), (req, res) => {
  const list = processList();
  const running = list.filter((item) => item.state === 'running').length;
  return respond.ok(res, {
    supervisor: {
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      status: running === DEFINITIONS.length ? 'healthy' : 'degraded',
      ingressPort: INGRESS_PORT
    },
    processes: list,
    isolation: 'process-level-only',
    note:
      'Four application/sidecar processes plus ingress run in one Render Free container. Separate containers are used locally and on AWS EC2.'
  });
});

app.get('/metrics', (req, res) => {
  const list = processList();
  return respond.ok(res, {
    ...stats.snapshot(),
    processes: list,
    running: list.filter((item) => item.state === 'running').length
  });
});

const statusServer = app.listen(STATUS_PORT, '127.0.0.1', () => {
  log.info('supervisor_status_listening', { port: STATUS_PORT, bindAddress: '127.0.0.1' });
  agent.start();
  for (const definition of DEFINITIONS) {
    startProcess(definition);
  }
});

let shuttingDownHandled = false;
async function shutdown(signal) {
  if (shuttingDownHandled) return;
  shuttingDownHandled = true;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const record of processes.values()) {
    if (record.pid) {
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch {
        // Process may already be gone.
      }
      record.state = 'stopped';
    }
  }
  statusServer.close();
  await agent.stop();
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) });
});
