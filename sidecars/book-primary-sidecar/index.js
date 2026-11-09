'use strict';

const { config, logger } = require('@mesh/shared');
const { createSidecar } = require('@mesh/shared/sidecar-runtime');

const NAME = 'book-primary-sidecar';
config.requireEnv(['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN'], NAME);
config.requireSecrets(['CONTROL_PLANE_SERVICE_TOKEN'], NAME);

const port = config.intEnv('BOOK_PRIMARY_SIDECAR_PORT', 5101, 1, 65535);
const upstreamUrl = config.optionalEnv('BOOK_SERVICE_URL', 'http://book-service:4101').replace(/\/+$/, '');
const advertiseUrl = config.optionalEnv('BOOK_PRIMARY_SIDECAR_ADVERTISE_URL', `http://${NAME}:${port}`);

logger.child(NAME).info('sidecar_starting', { port, upstreamUrl, cloud: 'aws' });

createSidecar({
  name: NAME,
  port,
  cloud: 'aws',
  role: 'book-primary',
  serviceName: 'book-service',
  upstreamUrl,
  advertiseUrl,
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN')
});
