'use strict';

const path = require('node:path');
const express = require('express');
const {
  config,
  logger,
  respond,
  requestId,
  securityHeaders,
  http
} = require('@mesh/shared');

const COMPONENT = 'dashboard';
const log = logger.child(COMPONENT);

config.requireEnv(['CONTROL_PLANE_URL', 'CONTROL_PLANE_READ_TOKEN'], COMPONENT);

const PORT = config.intEnv('DASHBOARD_PORT', 3000, 1, 65535);
const CP_URL = config.readEnv('CONTROL_PLANE_URL').replace(/\/+$/, '');
const READ_TOKEN = config.readEnv('CONTROL_PLANE_READ_TOKEN');
const DIST = path.join(__dirname, 'dist');

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requestId);
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (req, res) => {
  const result = await http.requestJson(`${CP_URL}/health`, { timeoutMs: 2000, retries: 0 });
  const reachable = Boolean(result.ok && result.json && result.json.data);
  return respond.ok(res, {
    component: COMPONENT,
    status: reachable ? 'healthy' : 'degraded',
    controlPlane: { url: CP_URL, reachable, lastError: result.error || null },
    staticBuildPresent: require('node:fs').existsSync(path.join(DIST, 'index.html'))
  });
});

// Server-side proxy: the browser never receives the read token. Weight updates
// must carry an operator-supplied x-admin-token header, which is forwarded as-is
// and validated by the Control Plane.
app.all('/api/*', async (req, res) => {
  const headers = {
    'x-read-token': READ_TOKEN,
    'content-type': req.get('content-type') || 'application/json'
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const adminToken = req.get('x-admin-token');
    if (adminToken) headers['x-admin-token'] = adminToken;
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {});
  const result = await http.requestJson(`${CP_URL}${req.originalUrl}`, {
    method: req.method,
    headers,
    body,
    timeoutMs: 6000,
    retries: 0
  });
  if (result.status === 0) {
    return respond.fail(res, 502, 'CONTROL_PLANE_UNAVAILABLE', 'The Control Plane is unreachable', {
      error: result.error
    });
  }
  res.status(result.status);
  res.setHeader('content-type', 'application/json');
  return res.send(result.text || JSON.stringify({ error: { code: 'EMPTY_RESPONSE', message: 'Empty response' } }));
});

app.use(express.static(DIST, { index: false }));
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'), (error) => {
    if (error) {
      res.status(503).json({
        error: {
          code: 'DASHBOARD_BUILD_MISSING',
          message: 'Dashboard build not found. Run npm run build in dashboard/.'
        }
      });
    }
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, controlPlane: CP_URL, staticBuild: DIST });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
