import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The dashboard dev server is a backend-for-frontend in development too.
  // The read token is injected server-side and never shipped to the browser.
  const rootEnv = loadEnv(mode, path.resolve(process.cwd(), '..'), '');
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 3000,
      proxy: {
        '/api': {
          target: rootEnv.CONTROL_PLANE_URL || 'http://localhost:4000',
          changeOrigin: true,
          headers: {
            'x-read-token': rootEnv.CONTROL_PLANE_READ_TOKEN || ''
          }
        }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  };
});
