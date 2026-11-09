'use strict';

const { config, logger } = require('@mesh/shared');
const { createSidecar } = require('@mesh/shared/sidecar-runtime');

const NAME = 'borrow-sidecar';
config.requireEnv(['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN'], NAME);
config.requireSecrets(['CONTROL_PLANE_SERVICE_TOKEN'], NAME);

const port = config.intEnv('BORROW_SIDECAR_PORT', 5102, 1, 65535);
const upstreamUrl = config.optionalEnv('BORROW_SERVICE_URL', 'http://borrow-service:4102').replace(/\/+$/, '');
const advertiseUrl = config.optionalEnv('BORROW_SIDECAR_ADVERTISE_URL', `http://${NAME}:${port}`);

logger.child(NAME).info('sidecar_starting', { port, upstreamUrl, cloud: 'aws' });

createSidecar({
  name: NAME,
  port,
  cloud: 'aws',
  role: 'borrow',
  serviceName: 'borrow-service',
  upstreamUrl,
  advertiseUrl,
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN')
});
