import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(),
       tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  // Phase 32.16 — localhost acceptance only: lets `npm run preview` serve
  // deep-links while /api reaches the local backend, mirroring `server.proxy`.
  // This is NOT production static hosting and NOT a CDN — the production
  // SPA-fallback/API-bypass contract is documented in
  // docs/PHASE_32_16_CDN_EDGE_STATIC_DELIVERY.md and owned by the future
  // static host/CDN (no vendor selected).
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});