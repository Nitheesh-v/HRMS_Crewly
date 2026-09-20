// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.16 — STATIC DELIVERY, CACHE-CONTROL & CDN-READINESS TESTS (§83)
//
// Hermetic: mock responses + ephemeral-loopback HTTP only. NO real CDN, no
// external network. Pins: the provider-neutral policy matrix, the API
// default-deny cache middleware, the Express res.download cache-header trap
// (behaviorally), SSE no-store, SPA/404 contract documentation, and the
// absence of private files from the frontend public surface.
// ═══════════════════════════════════════════════════════════════════════════
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const frontendRoot = path.join(backendRoot, '..', 'Frontend');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/synthetic_test_db';

const {
  STATIC_DELIVERY_POLICY,
  STATIC_DELIVERY_CATEGORIES,
  HEADER_OWNERSHIP,
  API_CACHE_POLICY_DEFAULT,
  staticDeliveryHeaderFor,
} = await import('../src/config/staticDeliveryPolicy.js');
const { apiCachePolicyMiddleware } = await import('../src/middlewares/apiCachePolicy.js');

// ── tiny mock response harness (repo-standard pattern) ────────────────────
const createRes = () => {
  const headers = {};
  return {
    headers,
    headersSent: false,
    setHeader(key, value) {
      headers[String(key).toLowerCase()] = value;
    },
    getHeader(key) {
      return headers[String(key).toLowerCase()];
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
describe('provider-neutral cache policy matrix (§61)', () => {
  test('index.html is NEVER year-long immutable', () => {
    const html = STATIC_DELIVERY_POLICY.INDEX_HTML;
    assert.equal(html.ownership, HEADER_OWNERSHIP.FUTURE_CDN_HOST);
    assert.ok(!/max-age=31536|immutable/.test(html.cacheControl), 'HTML must not be immutable');
    assert.match(html.cacheControl, /no-cache/);
  });

  test('hashed assets are long-lived public immutable (host-owned)', () => {
    const hashed = STATIC_DELIVERY_POLICY.HASHED_STATIC_ASSET;
    assert.equal(hashed.ownership, HEADER_OWNERSHIP.FUTURE_CDN_HOST);
    assert.match(hashed.cacheControl, /public/);
    assert.match(hashed.cacheControl, /max-age=31536000/);
    assert.match(hashed.cacheControl, /immutable/);
  });

  test('private files, authenticated API, token routes are never public/shared', () => {
    for (const category of ['PRIVATE_FILE', 'AUTHENTICATED_API', 'SECURE_TOKEN_ROUTE']) {
      const row = STATIC_DELIVERY_POLICY[category];
      assert.equal(row.ownership, HEADER_OWNERSHIP.CREWLY, `${category} must be Crewly-enforced`);
      assert.match(row.cacheControl, /private/);
      assert.match(row.cacheControl, /no-store/);
      assert.ok(!/public/.test(row.cacheControl), `${category} must not be public`);
    }
  });

  test('public non-versioned assets get a bounded policy, never immutable', () => {
    const row = STATIC_DELIVERY_POLICY.PUBLIC_NON_VERSIONED_ASSET;
    assert.match(row.cacheControl, /max-age=\d+/);
    assert.ok(!/immutable/.test(row.cacheControl), 'mutable-at-URL assets must not be immutable');
    const maxAge = Number(row.cacheControl.match(/max-age=(\d+)/)[1]);
    assert.ok(maxAge < 31536000, 'must be far shorter than the one-year immutable policy');
  });

  test('realtime streams are never cacheable and never buffered', () => {
    assert.match(STATIC_DELIVERY_POLICY.REALTIME_STREAM.cacheControl, /no-store/);
    const sseSource = read('src/routes/realtimeRoutes.js');
    assert.match(sseSource, /'Cache-Control':\s*'no-store'/);
    assert.match(sseSource, /'X-Accel-Buffering':\s*'no'/);
  });

  test('public-API caching is an UNDECIDED opt-in, not silently enabled', () => {
    assert.equal(STATIC_DELIVERY_POLICY.PUBLIC_API_OPT_IN.cacheControl, null);
  });

  test('matrix is complete and lookups resolve', () => {
    for (const category of STATIC_DELIVERY_CATEGORIES) {
      assert.ok('cacheControl' in STATIC_DELIVERY_POLICY[category], `${category} missing cacheControl`);
      assert.ok(STATIC_DELIVERY_POLICY[category].rationale.length > 20, `${category} needs a rationale`);
    }
    assert.equal(staticDeliveryHeaderFor('INDEX_HTML'), 'no-cache');
    assert.equal(staticDeliveryHeaderFor('NOPE'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('API default-deny cache middleware (§15/§83)', () => {
  test('sets private no-store on a bare response and calls next exactly once', () => {
    const res = createRes();
    let nextCalls = 0;
    apiCachePolicyMiddleware({ path: '/api/payslips' }, res, () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1);
    assert.equal(res.getHeader('Cache-Control'), API_CACHE_POLICY_DEFAULT);
    assert.match(String(res.getHeader('Cache-Control')), /private/);
    assert.match(String(res.getHeader('Cache-Control')), /no-store/);
  });

  test('does NOT overwrite a header an earlier layer already set', () => {
    const res = createRes();
    res.setHeader('Cache-Control', 'private, no-store');
    apiCachePolicyMiddleware({ path: '/api/x' }, res, () => {});
    assert.equal(res.getHeader('Cache-Control'), 'private, no-store');
  });

  test('a LATER (route-level) setter wins — documented override path', () => {
    const res = createRes();
    apiCachePolicyMiddleware({ path: '/api/x' }, res, () => {
      // Simulates a controller setting its explicit policy after the default.
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    });
    assert.equal(res.getHeader('Cache-Control'), 'private, no-store, max-age=0');
  });

  test('middleware is mounted before the router in app.js (structural)', () => {
    const source = read('src/app.js');
    const middlewarePos = source.indexOf('app.use(apiCachePolicyMiddleware)');
    const routerPos = source.indexOf("app.use('/api', routes)");
    assert.ok(middlewarePos > -1, 'apiCachePolicyMiddleware must be mounted');
    assert.ok(routerPos > middlewarePos, 'default must be set BEFORE routes so explicit headers can win');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('private download header survival (§13/§14) — behavioral, loopback', () => {
  test('res.download() does NOT clobber a pre-set private Cache-Control (Express pin)', async () => {
    const tmpFile = path.join(os.tmpdir(), `crewly-32_16-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'synthetic private document — never real data');
    const app = express();
    app.get('/private', (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.download(tmpFile, 'private.txt', () => {});
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const port = server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/private`);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('cache-control'),
        'private, no-store, max-age=0',
        'an Express upgrade must never turn a private download public — this pin guards that',
      );
      assert.ok(!/public/.test(response.headers.get('cache-control')));
    } finally {
      server.close();
      fs.rmSync(tmpFile, { force: true });
    }
  });

  test('default middleware + streaming response keeps the safe posture (mini-app)', async () => {
    const app = express();
    app.use(apiCachePolicyMiddleware);
    app.get('/api/export', (req, res) => {
      res.setHeader('Content-Type', 'text/csv');
      res.end('synthetic,header\n1,2');
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const port = server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/export`);
      assert.equal(response.headers.get('cache-control'), API_CACHE_POLICY_DEFAULT);
    } finally {
      server.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('SPA / static-host contract pins (§20/§21/§53/§54/§62)', () => {
  test('backend serves NO static frontend in production (honest ownership)', () => {
    const appSource = read('src/app.js');
    assert.ok(!appSource.includes('express.static'), 'API must not pretend to own static delivery');
    assert.ok(!appSource.includes('sendFile(indexHtml'), 'API must not become the SPA fallback owner');
  });

  test('frontend build stays root-relative and map-free (deployment-neutral)', () => {
    const viteConfig = fs.readFileSync(path.join(frontendRoot, 'vite.config.js'), 'utf8');
    assert.ok(!/base:\s*['"]https?:/.test(viteConfig), 'no hypothetical CDN URL may hard-code base');
    assert.ok(!/sourcemap:\s*true/.test(viteConfig), 'public source maps stay off');
    assert.match(viteConfig, /preview:\s*\{/, 'localhost preview proxy exists for acceptance testing');
  });

  test('no backend secret name is wired into frontend source (§53/§54)', () => {
    const forbidden = /VITE_(MONGO_URI|REDIS_URL|JWT_SECRET|FIELD_ENCRYPTION_KEY|SMTP_PASS|CLOUDINARY_API_SECRET|RAZORPAY_KEY_SECRET|CDN_SECRET)/;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx)$/.test(entry.name) && forbidden.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.basename(full));
        }
      }
    };
    walk(path.join(frontendRoot, 'src'));
    assert.deepEqual(offenders, []);
  });

  test('private HR documents are absent from the public frontend surface (§11)', () => {
    const publicDir = path.join(frontendRoot, 'public');
    const allowed = new Set(['favicon.png', 'favicon.svg', 'icons.svg', 'logo-crewly.png']);
    const names = fs.readdirSync(publicDir);
    for (const name of names) {
      assert.ok(allowed.has(name), `unexpected public asset "${name}" must be classified before CDN use`);
    }
  });

  test('chunk-load failures degrade to a user-visible reload, never an auto-loop', () => {
    const boundary = fs.readFileSync(path.join(frontendRoot, 'src', 'components', 'ChunkLoadErrorBoundary.jsx'), 'utf8');
    assert.match(boundary, /getDerivedStateFromError/, 'boundary must intercept render-time chunk failures');
    assert.match(boundary, /location\.reload/, 'user-visible recovery affordance must exist');
    assert.ok(!/setInterval|setTimeout\([^,]*reload/.test(boundary), 'no automatic reload loop');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('realtime & kiosk edge posture (§18/§52)', () => {
  test('SSE responses are marked no-store in the route (never edge-cached)', () => {
    const source = read('src/routes/realtimeRoutes.js');
    assert.match(source, /text\/event-stream/);
    assert.doesNotMatch(source, /max-age=\d{4,}/, 'no long-lived caching on streams');
  });

  test('kiosk API inherits the default-deny (no public business caching)', () => {
    const kiosk = read('src/routes/attendanceKioskRoutes.js');
    assert.ok(!/Cache-Control[^]*?public/.test(kiosk), 'kiosk routes must never set a public cache policy');
    // The app-level default (pinned above) supplies private, no-store.
  });
});
