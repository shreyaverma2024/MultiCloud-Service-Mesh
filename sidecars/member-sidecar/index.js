'use strict';

const { config, logger } = require('@mesh/shared');
const { createSidecar } = require('@mesh/shared/sidecar-runtime');

const NAME = 'member-sidecar';
config.requireEnv(['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN'], NAME);
config.requireSecrets(['CONTROL_PLANE_SERVICE_TOKEN'], NAME);

const port = config.intEnv('MEMBER_SIDECAR_PORT', 5105, 1, 65535);
const upstreamUrl = config.optionalEnv('MEMBER_SERVICE_URL', 'http://member-service:4105').replace(/\/+$/, '');
// In the Render bundle the advertised URL points at the single public ingress
// path, never at the private internal port.
const advertiseUrl = config.optionalEnv('MEMBER_SIDECAR_ADVERTISE_URL', `http://${NAME}:${port}`);

logger.child(NAME).info('sidecar_starting', { port, upstreamUrl, cloud: 'render' });

createSidecar({
  name: NAME,
  port,
  cloud: 'render',
  role: 'member',
  serviceName: 'member-service',
  upstreamUrl,
  advertiseUrl,
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN')
});
