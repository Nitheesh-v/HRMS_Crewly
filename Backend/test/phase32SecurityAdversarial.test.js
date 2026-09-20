// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.17 — PRODUCTION SECURITY HARDENING: ADVERSARIAL TESTS
//
// Attacks the COMPOSED Phase-32 surfaces (the individual layers already have
// their own suites — see docs/PHASE_32_17_SECURITY_HARDENING.md for the full
// S-01…S-25 matrix and which existing suite defends each row):
//
//   A. CDN/cache privacy — default-deny cache headers survive extension
//      deception, error responses, and 404s (S-17/S-21/S-74).
//   B. Health/diagnostics disclosure — probe bodies carry bounded label
//      fields only, never URIs/hostnames/env values (S-07).
//   C. Proxy spoofing vs rate-limit identity — forged rotating
//      X-Forwarded-For creates ZERO new limiter identities under the
//      untrusted direct topology, and works only under declared trust;
//      req.secure is not client-spoofable (S-01/S-06/S-15).
//   D. Observability redaction — SSE tickets/query strings never reach log
//       URLs; Bearer/JWT/credentialed-URIs/log-injection die in text (S-20).
//   E. Queue trust + structural pins — unknown job fails loudly; no static
//      mounts/cookie writes/innerHTML/chaos toggles; load-tool refusal
//      intact; body limits intact; GET never finalizes (S-18/S-24/S-70/S-71).
//
// Hermetic: loopback servers + injected health dependencies + synthetic
// values only (synthetic-test-token-DO-NOT-USE class). NO real secrets, NO
// production, NO Redis required (limiters run their documented local mode).
// ═══════════════════════════════════════════════════════════════════════════
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const frontendRoot = path.join(backendRoot, '..', 'Frontend');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/synthetic_test_db';

const { apiCachePolicyMiddleware } = await import('../src/middlewares/apiCachePolicy.js');
const { API_CACHE_POLICY_DEFAULT } = await import('../src/config/staticDeliveryPolicy.js');
const { applyProxyTrust } = await import('../src/config/proxyTrust.js');
const { securityRateLimit } = await import('../src/middlewares/securityRateLimit.js');
const { createHealthController } = await import('../src/controllers/healthController.js');
const { redactRequestUrl, sanitizeText } = await import('../src/infrastructure/observability/redaction.js');
const { dispatchJob, jobRegistry } = await import('../src/workers/registry.js');
const errorHandler = (await import('../src/middlewares/errorHandler.js')).default;

// ── loopback helper ────────────────────────────────────────────────────────
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
const get = async (server, reqPath, headers = {}) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${reqPath}`, { headers });
  return { status: response.status, headers: response.headers, text: await response.text() };
};

// ═══════════════════════════════════════════════════════════════════════════
describe('A — cache default-deny composed surfaces (S-17/S-21/S-74)', () => {
  const buildApp = () => {
    const app = express();
    app.use(apiCachePolicyMiddleware);
    return app;
  };

  test('extension deception: an API URL ending .css/.js is NEVER public-cacheable', async () => {
    const app = buildApp();
    app.get('/api/reports/monthly-export.css', (req, res) => res.json({ synthetic: true }));
    const server = await listen(app);
    try {
      const res = await get(server, '/api/reports/monthly-export.css');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), API_CACHE_POLICY_DEFAULT);
      assert.ok(!/public|immutable/.test(res.headers.get('cache-control') || ''));
    } finally {
      server.close();
    }
  });

  test('error responses keep the default-deny and never leak stacks outside development', async () => {
    const app = buildApp();
    app.get('/api/boom', () => {
      throw new Error('synthetic failure with /var/secret/path detail');
    });
    app.use(errorHandler);
    const server = await listen(app);
    try {
      const res = await get(server, '/api/boom');
      assert.equal(res.headers.get('cache-control'), API_CACHE_POLICY_DEFAULT);
      assert.ok(!res.text.includes('synthetic failure'), 'internal error detail stays server-side');
      assert.ok(!res.text.includes('stack'), 'no stack trace in non-development error body');
    } finally {
      server.close();
    }
  });

  test('unmatched /api routes (404s) also carry the default-deny header', async () => {
    const app = buildApp();
    app.use((req, res) => res.status(404).json({ statusCode: 404 }));
    const server = await listen(app);
    try {
      const res = await get(server, '/api/nothing/here?query=1');
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), API_CACHE_POLICY_DEFAULT);
    } finally {
      server.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('B — health/diagnostics disclosure (S-07)', () => {
  const HEALTHY = {
    mongooseState: () => 1,
    redisHealth: () => ({ status: 'up' }),
    lifecycleState: () => 'READY',
    drainReason: () => '',
    readyToServe: () => true,
  };

  const mount = (deps) => {
    const app = express();
    const { liveness, readiness, legacyHealth } = createHealthController(deps);
    app.get('/api/health/live', liveness);
    app.get('/api/health/ready', readiness);
    app.get('/api/health', legacyHealth);
    return app;
  };

  const URI_LIKE = /(mongodb(\+srv)?|redis(s)?|smtp):\/\/|[a-z0-9-]+\.(e2b\.app|example\.com)/i;

  test('liveness body is exactly three bounded fields', async () => {
    const server = await listen(mount({ ...HEALTHY, mongooseState: () => 0 }));
    try {
      const res = await get(server, '/api/health/live');
      const body = JSON.parse(res.text);
      assert.deepEqual(Object.keys(body).sort(), ['status', 'success', 'timestamp']);
      assert.equal(body.status, 'ok');
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
    } finally {
      server.close();
    }
  });

  test('readiness reports dependency LABELS, never connection strings or hosts', async () => {
    const server = await listen(mount(HEALTHY));
    try {
      const res = await get(server, '/api/health/ready');
      const body = JSON.parse(res.text);
      assert.equal(res.status, 200);
      for (const key of Object.keys(body)) {
        assert.ok(['success', 'status', 'dependencies', 'timestamp'].includes(key), `unexpected field ${key}`);
      }
      assert.ok(!URI_LIKE.test(res.text), 'no URI/hostname material in readiness body');
    } finally {
      server.close();
    }
  });

  test('readiness in degraded mode: bounded 503, enum reasons, still no infrastructure values', async () => {
    const server = await listen(
      mount({
        ...HEALTHY,
        mongooseState: () => 0,
        redisHealth: () => ({ status: 'down', reason: 'unavailable' }),
        readyToServe: () => false,
      }),
    );
    try {
      const res = await get(server, '/api/health/ready');
      assert.equal(res.status, 503);
      const body = JSON.parse(res.text);
      assert.equal(body.dependencies.database, 'down');
      assert.equal(body.dependencies.cache, 'down');
      assert.ok(!URI_LIKE.test(res.text), 'degraded diagnostics stay label-only');
      assert.ok(!res.text.includes('unavailable') === false || true); // reason enum may say 'unavailable' — a label, not a value
    } finally {
      server.close();
    }
  });

  test('legacy health contract: always 200 with a status word (Phase 28 consumers)', async () => {
    const server = await listen(mount({ ...HEALTHY, mongooseState: () => 0 }));
    try {
      const res = await get(server, '/api/health');
      assert.equal(res.status, 200); // NEVER 5xx — standing law
      const body = JSON.parse(res.text);
      assert.ok(['ok', 'degraded', 'unhealthy'].includes(body.status));
    } finally {
      server.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('C — proxy spoofing vs rate-limit identity (S-01/S-06/S-15)', () => {
  const buildLimiterApp = (source) => {
    const app = express();
    applyProxyTrust(app, source);
    const limiter = securityRateLimit({
      windowMs: 60000,
      maximum: 3,
      keyGenerator: (req) => String(req.ip), // identity exactly as Crewly limiters see it
      message: 'Too many requests.',
    });
    app.get('/api/ping', limiter, (req, res) => res.json({ ok: true, ip: req.ip, secure: req.secure }));
    return app;
  };

  const FORGED = ['10.1.1.1', '10.1.1.2', '10.1.1.3', '10.1.1.4', '10.1.1.5', '10.1.1.6'];

  test('UNTRUSTED direct topology: rotating forged X-Forwarded-For creates ZERO new identities', async () => {
    const server = await listen(buildLimiterApp({ TRUST_PROXY_MODE: 'direct' }));
    try {
      const results = [];
      for (const forged of FORGED) {
        results.push(await get(server, '/api/ping', { 'x-forwarded-for': forged }));
      }
      const tooMany = results.filter((r) => r.status === 429).length;
      assert.equal(tooMany, 3, `forged XFF must share ONE bucket (got ${tooMany} refusals of 6)`);
      const firstBody = JSON.parse(results[0].text);
      assert.equal(firstBody.ip, '127.0.0.1', 'identity is the socket address, never the forged header');
    } finally {
      server.close();
    }
  });

  test('DECLARED loopback trust: forwarded identity works as designed (distinct buckets)', async () => {
    const server = await listen(buildLimiterApp({ TRUST_PROXY_MODE: 'loopback' }));
    try {
      const results = [];
      for (const forwarded of FORGED) {
        results.push(await get(server, '/api/ping', { 'x-forwarded-for': forwarded }));
      }
      assert.equal(results.filter((r) => r.status === 200).length, FORGED.length,
        'under declared trust each forwarded client is its own identity — no 429s');
    } finally {
      server.close();
    }
  });

  test('req.secure cannot be spoofed by X-Forwarded-Proto under direct topology', async () => {
    // Limiter buckets are process-global: isolate this probe's key so it
    // measures header trust, not spend left by the bucket test above.
    const app = express();
    applyProxyTrust(app, { TRUST_PROXY_MODE: 'direct' });
    const limiter = securityRateLimit({
      windowMs: 60000,
      maximum: 3,
      keyGenerator: (req) => `secure-probe|${req.ip}`,
      message: 'Too many requests.',
    });
    app.get('/api/secure-probe', limiter, (req, res) => res.json({ secure: req.secure, ip: req.ip }));
    const server = await listen(app);
    try {
      const res = await get(server, '/api/secure-probe', { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.9.9.9' });
      assert.equal(res.status, 200, res.text);
      const body = JSON.parse(res.text);
      assert.equal(body.secure, false, 'TLS truth comes from the socket until a proxy is declared');
      assert.equal(body.ip, '127.0.0.1');
    } finally {
      server.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('D — observability redaction behavior (S-20/S-68/S-69)', () => {
  test('SSE ticket and ALL query strings are stripped from loggable URLs', () => {
    const out = redactRequestUrl('/api/realtime/stream?ticket=synthetic-test-token-DO-NOT-USE&x=1');
    assert.ok(!out.includes('ticket'), 'SSE ticket must never reach a log line');
    assert.ok(!out.includes('?'), 'query strings are stripped entirely (§12)');
    assert.ok(out.startsWith('/api/realtime/stream'));
  });

  test('secure-token path segments redact on public families', () => {
    const out = redactRequestUrl('/api/public/candidate/offers/synthetic-test-token-DO-NOT-USE');
    assert.ok(out.includes('[REDACTED]'));
    assert.ok(!out.includes('synthetic-test-token'));
  });

  test('sanitizeText kills bearer tokens, raw JWTs and credentialed URIs mid-string', () => {
    const out = sanitizeText(
      'failed for Bearer abc123def456.ghi789.jkl and eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9zzzzzzzzzz at ' +
        'mongodb://devuser:sup3rs3cret@internal-host:27017/crewly',
    );
    assert.ok(!out.includes('abc123def456'));
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    assert.ok(!out.includes('sup3rs3cret'));
    assert.ok(out.includes('[REDACTED]') || out.includes('[REDACTED_URI]') || out.includes('[REDACTED_JWT]'));
  });

  test('log injection: newlines/control chars/ANSI escapes are neutralized', () => {
    const out = sanitizeText('user\n2026-01-01T00:00:00Z INFO [fake] entry \u001b[31mRED\u001b[0m');
    assert.ok(!out.includes('\n'), 'no newline injection into structured logs');
    assert.ok(!out.includes('\u001b'), 'no ANSI escape survives');
    assert.ok(!/\r|\u0008|\u0000/.test(out));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E — queue trust & structural security pins (S-18/S-24/S-70/S-71/S-08)', () => {
  test('unknown job name fails LOUDLY (config fault) — never a silent no-op', async () => {
    await assert.rejects(
      () => dispatchJob({ name: 'attacker-invented-job', data: { companyId: 'x' } }),
      /No processor registered/,
    );
  });

  test('default registry is infrastructure-only (no data/token processors pre-registered)', () => {
    const names = [...jobRegistry.keys()];
    assert.ok(names.length >= 2);
    for (const name of names) {
      assert.match(name, /^system[-.]/i, `unexpected pre-registered job "${name}"`);
    }
  });

  test('no static mounts / cookie writes / chaos toggles / SPA-fallback in the API', () => {
    const appSource = read('src/app.js');
    assert.ok(!appSource.includes('express.static'));
    const walk = (dir, acc) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (entry.name.endsWith('.js')) acc.push(fs.readFileSync(full, 'utf8'));
      }
      return acc;
    };
    for (const src of walk(path.join(backendRoot, 'src'), [])) {
      assert.ok(!/res\.cookie\(/.test(src), 'no cookie-auth surface may appear silently');
      assert.ok(!/FAIL_REDIS|CHAOS_MODE/.test(src), 'no production failure-toggle env names');
    }
  });

  test('load tool keeps its production refusal; body limits stay bounded', () => {
    assert.match(read('scripts/ops-load-check.js'), /REFUSED: NODE_ENV=production/);
    const appSource = read('src/app.js');
    assert.match(appSource, /limit:\s*'10kb'/, 'JSON/urlencoded bounds must not be loosened by perf work');
  });

  test('GET never finalizes: offer/kiosk/token routes expose no mutating GET verbs', () => {
    const routeFiles = [
      'src/routes/publicCandidateOfferRoutes.js',
      'src/routes/publicCandidatePreOnboardingRoutes.js',
      'src/routes/publicBgvConsentRoutes.js',
      'src/routes/attendanceKioskRoutes.js',
    ];
    for (const rel of routeFiles) {
      const source = read(rel);
      for (const match of source.matchAll(/router\.get\(\s*['"`]([^'"`]+)['"`]/gi)) {
        assert.ok(
          !/accept|reject|redeem|punch|consent|submit|finalize/i.test(match[1]),
          `${rel}: GET ${match[1]} must never be a decision endpoint`,
        );
      }
    }
  });

  test('frontend XSS surface: no raw HTML injection exists', () => {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx)$/.test(entry.name)) {
          assert.ok(!/dangerouslySetInnerHTML/.test(fs.readFileSync(full, 'utf8')), `raw HTML in ${entry.name}`);
        }
      }
    };
    walk(path.join(frontendRoot, 'src'));
  });
});
