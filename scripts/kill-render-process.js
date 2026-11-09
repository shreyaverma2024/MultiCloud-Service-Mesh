'use strict';

/**
 * Kills one supervised process inside the Render bundle container so the
 * supervisor's restart behaviour can be observed. Run from the host:
 *
 *   node scripts/kill-render-process.js member-service
 *
 * Or from inside the container:
 *
 *   node scripts/kill-render-process.js member-service
 */

const { spawnSync } = require('node:child_process');

const PROCESSES = {
  'book-replica-service': 'services/book-replica-service/index.js',
  'book-replica-sidecar': 'sidecars/book-replica-sidecar/index.js',
  'member-service': 'services/member-service/index.js',
  'member-sidecar': 'sidecars/member-sidecar/index.js',
  'render-ingress': 'render/ingress.js'
};

const name = process.argv[2];
if (!name || !PROCESSES[name]) {
  console.error(`Usage: node scripts/kill-render-process.js <${Object.keys(PROCESSES).join('|')}>`);
  process.exit(1);
}

const script = PROCESSES[name];
const result = spawnSync('pkill', ['-f', script], { stdio: 'inherit' });

if (result.error) {
  console.error(`Could not run pkill: ${result.error.message}`);
  process.exit(1);
}

// pkill exits 1 when no process matched. That is a useful signal for the
// caller, so preserve it.
if (result.status !== 0) {
  console.error(`No running process matched ${name} (${script}).`);
  process.exit(result.status || 1);
}

console.log(`Killed ${name} (${script}). The supervisor should restart it.`);
