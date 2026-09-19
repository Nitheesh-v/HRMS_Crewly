import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(),
       tailwindcss(),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
    // allow preview host (e.g. https://{port}-{sandboxId}.e2b.app) to reach dev server
    cors: true,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
});
