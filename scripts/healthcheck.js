'use strict';

/**
 * Minimal container healthcheck helper.
 * Usage: node scripts/healthcheck.js http://127.0.0.1:8080/health [timeoutMs]
 */

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] || 2000);

if (!url) {
  console.error('Usage: node scripts/healthcheck.js <url> [timeoutMs]');
  process.exit(1);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

fetch(url, { signal: controller.signal, redirect: 'manual' })
  .then((response) => {
    if (!response.ok) {
      console.error(`Healthcheck failed: ${url} returned HTTP ${response.status}`);
      process.exit(1);
    }
    return response.text().then(() => process.exit(0));
  })
  .catch((error) => {
    console.error(`Healthcheck failed: ${url}: ${error.name === 'AbortError' ? 'timeout' : error.message}`);
    process.exit(1);
  })
  .finally(() => clearTimeout(timer));
