'use strict';

const { config, logger } = require('@mesh/shared');
const { createSidecar } = require('@mesh/shared/sidecar-runtime');

const NAME = 'notification-sidecar';
config.requireEnv(['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN'], NAME);
config.requireSecrets(['CONTROL_PLANE_SERVICE_TOKEN'], NAME);

const port = config.intEnv('NOTIFICATION_SIDECAR_PORT', 5103, 1, 65535);
const upstreamUrl = config.optionalEnv('NOTIFICATION_SERVICE_URL', 'http://notification-service:4103').replace(/\/+$/, '');
const advertiseUrl = config.optionalEnv('NOTIFICATION_SIDECAR_ADVERTISE_URL', `http://${NAME}:${port}`);

logger.child(NAME).info('sidecar_starting', { port, upstreamUrl, cloud: 'aws' });

createSidecar({
  name: NAME,
  port,
  cloud: 'aws',
  role: 'notification',
  serviceName: 'notification-service',
  upstreamUrl,
  advertiseUrl,
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN')
});
