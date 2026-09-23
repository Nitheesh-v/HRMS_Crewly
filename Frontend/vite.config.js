import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'

// Phase 33.8 — the chat socket connects SAME-ORIGIN through these proxies
// (browser code never hard-codes a backend host). `ws: true` is what lets
// Socket.IO's WebSocket upgrade traverse the dev/preview proxy.
const backendProxies = {
  '/api': {
    target: 'http://localhost:5000',
    changeOrigin: true,
    ws: true,
  },
  '/socket.io': {
    target: 'http://localhost:5000',
    changeOrigin: true,
    ws: true,
  },
};

export default defineConfig({
  plugins: [react(),
       tailwindcss(),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Arena live-preview support in development only (mirrors the
    // backend's dev-only e2b CORS allowance in src/app.js). Production
    // static hosting is a separate layer and unaffected.
    allowedHosts: ['.e2b.app'],
    proxy: backendProxies,
  },
  // Phase 32.16 — localhost acceptance only: lets `npm run preview` serve
  // deep-links while /api + /socket.io reach the local backend, mirroring
  // `server.proxy`. This is NOT production static hosting and NOT a CDN —
  // the production SPA-fallback/API-bypass contract is documented in
  // docs/PHASE_32_16_CDN_EDGE_STATIC_DELIVERY.md and owned by the future
  // static host/CDN (no vendor selected).
  // (33.8: the earlier duplicate `preview` key silently dropped the proxy
  // block — merged here into one definition.)
  preview: {
    host: '0.0.0.0',
    port: 4173,
    proxy: backendProxies,
    cors: true,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
    },
  },
});
