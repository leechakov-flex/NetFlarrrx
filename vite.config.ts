import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web UI lives in web/ and builds into dist/web, which the server serves.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8484', '/healthz': 'http://127.0.0.1:8484' } },
});
