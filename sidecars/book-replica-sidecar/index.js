'use strict';

const { config, logger } = require('@mesh/shared');
const { createSidecar } = require('@mesh/shared/sidecar-runtime');

const NAME = 'book-replica-sidecar';
config.requireEnv(['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN'], NAME);
config.requireSecrets(['CONTROL_PLANE_SERVICE_TOKEN'], NAME);

const port = config.intEnv('BOOK_REPLICA_SIDECAR_PORT', 5104, 1, 65535);
const upstreamUrl = config.optionalEnv('BOOK_REPLICA_SERVICE_URL', 'http://book-replica-service:4104').replace(/\/+$/, '');
// In the Render bundle the advertised URL points at the single public ingress
// path, never at the private internal port.
const advertiseUrl = config.optionalEnv('BOOK_REPLICA_SIDECAR_ADVERTISE_URL', `http://${NAME}:${port}`);

logger.child(NAME).info('sidecar_starting', { port, upstreamUrl, cloud: 'render' });

createSidecar({
  name: NAME,
  port,
  cloud: 'render',
  role: 'book-replica',
  serviceName: 'book-replica-service',
  upstreamUrl,
  advertiseUrl,
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN')
});
