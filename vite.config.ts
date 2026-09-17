import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite serves the React app in dev on :5173 and proxies API + SSE to the
// Node gateway on :8080. `vite build` emits static assets the gateway serves
// in production, so the whole demo runs on a single port when deployed.
export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  publicDir: false,
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // SSE needs the connection kept open, not buffered.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('accept-encoding', 'identity'));
        },
      },
      '/healthz': 'http://localhost:8080',
    },
  },
});
