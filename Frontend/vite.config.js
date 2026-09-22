import { existsSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'

// Extensions that mean "this request is asking for a static file", not an app route.
const STATIC_FILE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'css', 'map', 'json', 'txt', 'xml', 'wasm',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

// Phase 32.16 §9 / acceptance Step 5 — LOCALHOST PREVIEW FIDELITY ONLY.
// The contract: `/assets/*` (and any static-file request) that does not exist
// must 404 — never `index.html` with 200, because HTML served as JS produces
// confusing MIME/ChunkLoad errors. `vite preview`'s SPA fallback returns
// HTML for ANY unmatched path, so the documented check
// (`GET /assets/does-not-exist-abc123.js` → 404) could not pass locally.
// This guard runs BEFORE Vite's internal middlewares, only delegates when the
// file really exists on disk, and lets everything else (app paths, deep links)
// fall through to the normal SPA fallback. `configurePreviewServer` is invoked
// by `vite preview` alone — `vite dev` and `vite build` are untouched, and the
// production static host/CDN still owns this rule in production (no vendor
// selected; see docs/PHASE_32_16_CDN_EDGE_STATIC_DELIVERY.md).
const decodePathname = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const previewAssetFallbackGuard = () => ({
  name: 'crewly-preview-asset-404',
  configurePreviewServer: (server) => {
    const distDir = resolvePath(server.config.root, server.config.build.outDir);
    server.middlewares.use((req, res, next) => {
      const [rawPath = '/'] = (req.url ?? '/').split('?');
      const pathname = decodePathname(rawPath);
      const isInternalPath =
        pathname.startsWith('/api/') ||
        pathname.startsWith('/@') ||
        pathname.startsWith('/node_modules/');
      const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
      const extension = lastSegment.includes('.')
        ? lastSegment.slice(lastSegment.lastIndexOf('.') + 1).toLowerCase()
        : '';
      const looksLikeStaticFile =
        pathname.startsWith('/assets/') || STATIC_FILE_EXTENSIONS.has(extension);
      if (isInternalPath || !looksLikeStaticFile) return next();
      // Traversal-refusing: only a path that stays inside dist may be served.
      const candidate = resolvePath(distDir, `.${pathname}`);
      const insideDist = candidate === distDir || candidate.startsWith(`${distDir}${sep}`);
      if (insideDist && existsSync(candidate)) return next();
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(
        '404 Not Found — missing static asset (asset paths never fall back to index.html).\n',
      );
    });
  },
});

export default defineConfig({
  plugins: [react(),
       tailwindcss(),
       previewAssetFallbackGuard(),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Arena live-preview support in development only (mirrors the
    // backend's dev-only e2b CORS allowance in src/app.js). Production
    // static hosting is a separate layer and unaffected.
    allowedHosts: ['.e2b.app'],
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
  //
  // ONE block only: `preview` keys are not merged by Vite (a second block
  // silently replaces the first), so the documented port (4173), the `/api`
  // proxy, `cors` and the framing header must all live here together.
  preview: {
    host: '0.0.0.0',
    port: 4173,
    // Same dev-only preview-host allowance as `server.allowedHosts` —
    // covers https://{port}-{sandboxId}.e2b.app. Production unaffected.
    allowedHosts: ['.e2b.app'],
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
    cors: true,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
    },
  },
});
