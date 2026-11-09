
'use strict';

const { requestJson, delay } = require('./http');
const logger = require('./logger');

/**
 * Registers a component with the Control Plane and keeps sending real
 * heartbeats. The Control Plane marks a component Unknown/Disconnected when
 * heartbeats stop, so the dashboard never reports a stopped process as healthy.
 *
 * If the Control Plane is unavailable, the component keeps running with its
 * last valid configuration. Sidecars specifically retain their last config.
 */
class MeshAgent {
  constructor({
    controlPlaneUrl,
    serviceToken,
    component,
    getStatus = () => 'healthy',
    getMetrics = () => ({}),
    getMeta = () => ({}),
    onConfig = null,
    heartbeatIntervalMs = 3000,
    configIntervalMs = 5000,
    componentName = null
  }) {
    if (!controlPlaneUrl) throw new Error('Control Plane URL is required');
    if (!serviceToken) throw new Error('Control Plane service token is required');

    this.controlPlaneUrl = controlPlaneUrl.replace(/\/+$/, '');
    this.serviceToken = serviceToken;

    this.component = {
      kind: 'service',
      cloud: 'aws',
      role: 'service',
      version: process.env.APP_VERSION || '1.0.0',
      ...component
    };

    this.getStatus = getStatus;
    this.getMetrics = getMetrics;
    this.getMeta = getMeta;
    this.onConfig = onConfig;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.configIntervalMs = configIntervalMs;
    this.log = logger.child(componentName || this.component.id || 'mesh-agent');

    this.registered = false;
    this.stopped = false;
    this.heartbeatBusy = false;
    this.configBusy = false;
    this.configVersion = null;
    this.lastError = null;
    this.failedAttempts = 0;
    this.timers = [];
  }

  start() {
    if (this.stopped) return;

    void this.registerWithRetry();

    this.timers.push(
      setInterval(() => {
        void this.heartbeat();
      }, this.heartbeatIntervalMs)
    );

    if (typeof this.onConfig === 'function') {
      this.timers.push(
        setInterval(() => {
          void this.fetchConfig();
        }, this.configIntervalMs)
      );
    }
  }

  async registerWithRetry() {
    let waitMs = 500;

    while (!this.stopped && !this.registered) {
      await this.register();

      if (this.registered) break;

      await delay(waitMs);
      waitMs = Math.min(5000, waitMs * 2);
    }
  }

  async register() {
    try {
      const result = await requestJson(
        `${this.controlPlaneUrl}/api/registry/register`,
        {
          method: 'POST',
          headers: {
            'x-service-token': this.serviceToken,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            ...this.component,
            meta: {
              ...(this.component.meta || {}),
              ...this.safeCall(this.getMeta, {})
            },
            startedAt: this.component.startedAt || new Date().toISOString()
          }),
          timeoutMs: 2500,
          retries: 0
        }
      );

      if (result.ok) {
        this.registered = true;
        this.failedAttempts = 0;
        this.lastError = null;

        this.log.info('registered_with_control_plane', {
          cloud: this.component.cloud
        });
      } else {
        this.failedAttempts += 1;
        this.lastError = result.error || `http_${result.status}`;

        if (this.failedAttempts === 1 || this.failedAttempts % 10 === 0) {
          this.log.warn('registration_failed', {
            status: result.status,
            error: result.error || null,
            timedOut: result.timedOut || false,
            durationMs: result.durationMs,
            attempts: this.failedAttempts
          });
        }
      }
    } catch (error) {
      this.failedAttempts += 1;
      this.lastError = error.message;

      if (this.failedAttempts === 1 || this.failedAttempts % 10 === 0) {
        this.log.warn('registration_unreachable', {
          message: error.message,
          attempts: this.failedAttempts
        });
      }
    }
  }

  safeCall(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  async heartbeat() {
    if (this.stopped || this.heartbeatBusy) return;

    if (!this.registered) {
      void this.registerWithRetry();
      return;
    }

    this.heartbeatBusy = true;

    try {
      const payload = {
        id: this.component.id,
        status: this.safeCall(this.getStatus, 'unknown'),
        metrics: this.safeCall(this.getMetrics, {}),
        meta: this.safeCall(this.getMeta, {}),
        configVersion: this.configVersion,
        ts: Date.now()
      };

      const result = await requestJson(
        `${this.controlPlaneUrl}/api/registry/heartbeat`,
        {
          method: 'POST',
          headers: {
            'x-service-token': this.serviceToken,
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload),
          timeoutMs: 2000,
          retries: 0
        }
      );

      if (!result.ok) {
        this.lastError = `heartbeat_http_${result.status}`;

        if (result.status === 401 || result.status === 404) {
          this.registered = false;

          this.log.warn('heartbeat_rejected_re_registering', {
            status: result.status
          });
        }
      } else {
        this.lastError = null;
      }
    } catch (error) {
      this.lastError = error.message;
    } finally {
      this.heartbeatBusy = false;
    }
  }

  async fetchConfig() {
    if (
      this.stopped ||
      this.configBusy ||
      typeof this.onConfig !== 'function'
    ) {
      return;
    }

    this.configBusy = true;

    try {
      const result = await requestJson(
        `${this.controlPlaneUrl}/api/config/sidecar/${encodeURIComponent(this.component.id)}`,
        {
          headers: {
            'x-service-token': this.serviceToken
          },
          timeoutMs: 2000,
          retries: 0
        }
      );

      if (result.ok && result.json && result.json.data) {
        this.configVersion = result.json.data.version;
        this.onConfig(result.json.data);
      }
    } catch {
      // Keep the last valid configuration. This is intentional.
    } finally {
      this.configBusy = false;
    }
  }

  reportEvent({ severity = 'info', type, message, details = {} }) {
    if (this.stopped) return;

    void requestJson(`${this.controlPlaneUrl}/api/events`, {
      method: 'POST',
      headers: {
        'x-service-token': this.serviceToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        severity,
        type,
        message,
        source: this.component.id,
        cloud: this.component.cloud,
        details
      }),
      timeoutMs: 1500,
      retries: 0
    }).catch(() => {});
  }

  async stop() {
    this.stopped = true;

    for (const timer of this.timers) {
      clearInterval(timer);
    }

    this.timers = [];

    if (!this.registered) return;

    try {
      await requestJson(
        `${this.controlPlaneUrl}/api/registry/deregister`,
        {
          method: 'POST',
          headers: {
            'x-service-token': this.serviceToken,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            id: this.component.id,
            reason: 'graceful_shutdown'
          }),
          timeoutMs: 800,
          retries: 0
        }
      );
    } catch {
      // Best effort only.
    }
  }
}

module.exports = { MeshAgent };
