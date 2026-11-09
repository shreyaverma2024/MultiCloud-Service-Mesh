'use strict';

const { MeshStore } = require('../../control-plane/store');

function register(store, id, overrides = {}) {
  return store.register({
    id,
    name: id,
    kind: overrides.kind || 'service',
    cloud: overrides.cloud || 'aws',
    role: overrides.role || 'service',
    baseUrl: overrides.baseUrl || `http://${id}:4100`,
    status: 'healthy',
    meta: overrides.meta || {}
  });
}

describe('MeshStore', () => {
  test('registers components and returns public records', () => {
    const store = new MeshStore({ mode: 'split' });
    const record = register(store, 'book-service');
    expect(record.id).toBe('book-service');
    expect(store.getComponent('book-service').effectiveStatus).toBe('healthy');
    expect(store.listComponents({ kind: 'service' })).toHaveLength(1);
    expect(store.events.some((event) => event.type === 'service_registered')).toBe(true);
  });

  test('marks a component unknown after heartbeats stop', () => {
    const store = new MeshStore({ mode: 'split', staleMs: 50 });
    register(store, 'book-service');
    store.components.get('book-service').lastHeartbeat = Date.now() - 1000;
    store.sweep();
    const record = store.getComponent('book-service');
    expect(record.disconnected).toBe(true);
    expect(record.effectiveStatus).toBe('unknown');
    expect(store.events.some((event) => event.type === 'component_disconnected')).toBe(true);
  });

  test('recovers after a fresh heartbeat', () => {
    const store = new MeshStore({ mode: 'split', staleMs: 50 });
    register(store, 'book-service');
    store.components.get('book-service').lastHeartbeat = Date.now() - 1000;
    store.sweep();
    store.heartbeat({ id: 'book-service', status: 'healthy', metrics: {}, meta: {} });
    expect(store.getComponent('book-service').disconnected).toBe(false);
    expect(store.getComponent('book-service').effectiveStatus).toBe('healthy');
  });

  test('updates book weights only when they total 100', () => {
    const store = new MeshStore({ mode: 'split' });
    const invalid = store.setBookWeights(60, 30, 'test');
    expect(invalid.ok).toBe(false);
    expect(store.getBookRouting().policy).toEqual({ aws: 70, render: 30 });

    const valid = store.setBookWeights(40, 60, 'test');
    expect(valid.ok).toBe(true);
    expect(valid.routing.version).toBe(2);
    expect(store.getBookRouting().policy).toEqual({ aws: 40, render: 60 });
    expect(store.events.some((event) => event.type === 'traffic_weight_change')).toBe(true);
  });

  test('builds routing targets from registered sidecars', () => {
    const store = new MeshStore({ mode: 'split' });
    register(store, 'book-primary-sidecar', {
      kind: 'sidecar',
      baseUrl: 'http://book-primary-sidecar:5101',
      meta: { upstream: 'book-service' }
    });
    register(store, 'book-replica-sidecar', {
      kind: 'sidecar',
      cloud: 'render',
      baseUrl: 'http://render-web:8081/book-replica',
      meta: { upstream: 'book-replica-service' }
    });
    const routing = store.getBookRouting();
    expect(routing.targets).toHaveLength(2);
    expect(routing.targets[0].routable).toBe(true);
    expect(routing.targets[1].cloud).toBe('render');
    expect(routing.targets[1].weight).toBe(30);
  });

  test('includes expected components and alerts in status', () => {
    const store = new MeshStore({ mode: 'bundle' });
    const status = store.buildStatus();
    expect(status.mode).toBe('bundle');
    expect(status.expected).toHaveLength(14);
    expect(status.alerts.some((alert) => alert.type === 'component_not_registered')).toBe(true);
    expect(status.render.note).toContain('ONE Render Free web service');
  });
});
