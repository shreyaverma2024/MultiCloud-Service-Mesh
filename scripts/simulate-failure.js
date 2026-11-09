'use strict';

/**
 * Local failure simulation helper.
 *
 * Examples:
 *   node scripts/simulate-failure.js stop book-service
 *   node scripts/simulate-failure.js start book-service
 *   node scripts/simulate-failure.js pause book-service
 *   node scripts/simulate-failure.js unpause book-service
 *   node scripts/simulate-failure.js redis-down
 *   node scripts/simulate-failure.js redis-up
 *   node scripts/simulate-failure.js db-down
 *   node scripts/simulate-failure.js db-up
 *   node scripts/simulate-failure.js cp-down
 *   node scripts/simulate-failure.js cp-up
 *   node scripts/simulate-failure.js kill-render-process member-service
 *
 * This only controls local Docker Compose services. It never contacts a cloud
 * provider and never changes project files.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadEnv } = require('./lib/load-env');

loadEnv();

const [action, target] = process.argv.slice(2);
const profile = process.env.COMPOSE_PROFILE || process.env.MESH_MODE || 'split';
const root = path.resolve(__dirname, '..');

function docker(args) {
  console.log(`$ docker ${args.join(' ')}`);
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to run docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

function compose(verb, service) {
  docker(['compose', '--profile', profile, verb, service]);
}

const aliases = {
  'redis-down': () => compose('stop', 'redis'),
  'redis-up': () => compose('start', 'redis'),
  'db-down': () => compose('stop', 'postgres'),
  'db-up': () => compose('start', 'postgres'),
  'cp-down': () => compose('stop', 'control-plane'),
  'cp-up': () => compose('start', 'control-plane'),
  'kill-render-process': () => {
    if (!target) {
      console.error('kill-render-process needs a process name.');
      process.exit(1);
    }
    docker(['compose', '--profile', 'bundle', 'exec', '-T', 'render-web', 'node', 'scripts/kill-render-process.js', target]);
  }
};

if (!action) {
  console.error('Usage: node scripts/simulate-failure.js <action> [target]');
  process.exit(1);
}

if (aliases[action]) {
  aliases[action]();
  process.exit(0);
}

const allowed = new Set(['stop', 'start', 'restart', 'pause', 'unpause']);
if (!allowed.has(action) || !target) {
  console.error(`Unsupported action "${action}". Use one of: ${[...allowed].join(', ')}, redis-down, redis-up, db-down, db-up, cp-down, cp-up, kill-render-process.`);
  process.exit(1);
}

compose(action, target);
