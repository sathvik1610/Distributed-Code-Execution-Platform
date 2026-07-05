import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// The gateway requires X-API-Key on every route except /health. We inject it
// here, server-side in the Vite dev process, so the key never reaches the
// browser bundle — mirrors how Caddy injects it in production (see Phase 2).
// Never read this into a VITE_-prefixed variable: anything prefixed VITE_
// gets inlined into the client bundle at build time.
const API_TARGET = process.env.API_TARGET || 'http://localhost:8000';
const DEV_API_KEY = process.env.DEV_API_KEY || 'test-api-key'; // matches infra/docker-compose.services.yml

// Typed loosely (Vite's `configure` callback receives an `http-proxy` server
// instance, which we don't depend on directly as a package).
function injectApiKey(proxy: any) {
  proxy.on('proxyReq', (proxyReq: any) => {
    proxyReq.setHeader('X-API-Key', DEV_API_KEY);
  });
  // The WebSocket upgrade handshake fires a *separate* event from a normal
  // proxied request — a proxyReq-only listener never sees it, so /stream
  // would be sent without the header and get rejected with 401.
  proxy.on('proxyReqWs', (proxyReq: any) => {
    proxyReq.setHeader('X-API-Key', DEV_API_KEY);
  });
}

function apiProxy(ws = false): ProxyOptions {
  return {
    target: API_TARGET,
    changeOrigin: true,
    ws,
    configure: injectApiKey,
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/submissions': apiProxy(),
      '/dlq': apiProxy(),
      '/health': apiProxy(),
      '/stream': apiProxy(true),
    },
  },
});
