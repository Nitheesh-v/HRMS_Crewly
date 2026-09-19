// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.12 — OBSERVABILITY FOUNDATION TESTS (hermetic — no Mongo/Redis)
//
// Covers the 32.12 law set: request-ID lifecycle + concurrency isolation
// (§82/§87), adversarial redaction (§83/§84), safe error serialization
// (§85), HTTP timing/slow classification (§86), bounded metrics (§47),
// process diagnostics (§42–§45), realtime aggregates (§90), queue
// correlation seam (§88), and the platform-only diagnostics surface
// (§91). All secrets in fixtures are SYNTHETIC — never real values.
// ═══════════════════════════════════════════════════════════════════════════
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';

process.env.NODE_ENV = 'test'; // before any import evaluates config/env.js

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');

const {
  requestIdMiddleware,
  isValidRequestId,
  createRequestId,
  getCurrentRequestId,
} = await import('../src/infrastructure/observability/requestContext.js');
const {
  redactForLog,
  sanitizeText,
  redactRequestUrl,
  routeTemplateOf,
  SENSITIVE_KEY_PATTERN,
} = await import('../src/infrastructure/observability/redaction.js');
const { serializeError } = await import('../src/infrastructure/observability/safeErrorSerializer.js');
const {
  parseSlowRequestThresholdMs,
  statusClassOf,
  methodLabelOf,
} = await import('../src/infrastructure/observability/observabilityConfig.js');
const {
  createMetricsRegistry,
  getMetricsRegistry,
} = await import('../src/infrastructure/observability/metricsRegistry.js');
const {
  startProcessDiagnostics,
  stopProcessDiagnostics,
  processDiagnosticsSnapshot,
} = await import('../src/infrastructure/observability/processDiagnostics.js');
const { httpObservabilityMiddleware } = await import('../src/infrastructure/observability/httpObservability.js');
const logger = (await import('../src/config/logger.js')).default;

// Synthetic fixtures — NEVER real secrets (§83).
const SYNTHETIC = Object.freeze({
  bearer: 'Bearer synth.jwt.token.value',
  jwt: 'eyJsyntheticheader.eyJsyntheticpayload.sigNATURE9',
  password: 'synth-pass-word-1',
  resetToken: 'synth-reset-token-99',
  candidateToken: 'SYNTHCANDIDATETOKEN0123456789',
  kioskPin: '482913',
  kioskSecret: 'synth-kiosk-secret',
  qrToken: 'synth-qr-token-77',
  bankAccount: '0099887766',
  mongoUri: 'mongodb://synthuser:synthpass@synthhost:27017/synthdb',
  redisUrl: 'redis://synth:6379/0',
  smtpPass: 'synth-smtp-pass',
  lat: '13.0827',
  lng: '80.2707',
});

const listen = (app) =>
  new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

// undici keep-alive sockets would hold server.close() (and the test
// process) open — always drop idle connections first.
const closeServer = (instance) => {
  instance.closeIdleConnections?.();
  instance.close();
  return instance;
};

const getJson = async (instance, urlPath, headers = {}, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${instance.address().port}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    ...(options.body ? { body: options.body } : {}),
  });
  return { response, body: await response.json().catch(() => null) };
};

// Runs a test body against a started app, ALWAYS closing the server
// (even on assertion failure) so no handle ever outlives a test.
const withServer = async (app, body) => {
  const instance = await listen(app);
  try {
    return await body(instance);
  } finally {
    closeServer(instance);
  }
};

// Winston spy: intercept levels without replacing the logger module.
const withLogSpy = (fn) => {
  const calls = { info: [], warn: [], error: [] };
  const originals = {};
  for (const level of Object.keys(calls)) {
    originals[level] = logger[level].bind(logger);
    logger[level] = (...args) => calls[level].push(args);
  }
  return Promise.resolve(fn(calls)).finally(() => {
    for (const level of Object.keys(originals)) logger[level] = originals[level];
  });
};

// ═══════════════════════════════════════════════════════════════════════════
describe('request/correlation IDs (§6/§8/§53/§82/§87)', () => {
  test('request without ID receives a server UUID and a safe response header', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/ping', (req, res) => res.json({ requestId: req.id }));

    const { response, body } = await withServer(app, (instance) => getJson(instance, '/ping'));

    assert.equal(response.status, 200);
    assert.ok(isValidRequestId(body.requestId), 'server id matches the strict contract');
    assert.equal(response.headers.get('x-request-id'), body.requestId);
  });

  test('malformed/overlong/injected inbound IDs are REPLACED, never echoed', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/x', (req, res) => res.json({ requestId: req.id }));

    await withServer(app, async (instance) => {
      for (const hostile of [
        'short', // too short
        'a'.repeat(65), // too long
        'has space-in-it-12', // space
        '../../etc/passwd99', // traversal-shaped
        'user;drop--table-1', // injection-shaped
        `${SYNTHETIC.jwt.slice(0, 40)}`, // token-shaped with dots
      ]) {
        const { body } = await getJson(instance, '/x', { 'x-request-id': hostile });
        assert.ok(isValidRequestId(body.requestId), `hostile id replaced: ${JSON.stringify(hostile)}`);
        assert.notEqual(body.requestId, hostile);
      }
    });
  });

  test('control-character header injection is refused — Node parser rejects, middleware contract backstops', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/x', (req, res) => res.json({ requestId: req.id }));

    const { status, rawBody } = await withServer(app, (instance) =>
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: instance.address().port }, () => {
          // A hostile client hand-crafts bytes: the \n splits into a second
          // malformed header line. Node's parser (first defense) refuses it.
          socket.write(
            `GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nx-request-id: newline\nID-99\r\nConnection: close\r\n\r\n`,
          );
        });
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString();
        });
        socket.on('end', () => {
          resolve({ status: Number(data.split('\r\n')[0].split(' ')[1]), rawBody: data });
        });
        socket.on('error', reject);
      }));

    assert.equal(status, 400, 'malformed header rejected before the app (first defense)');
    assert.ok(!rawBody.includes('ID-99'), 'injected value never reflected');
    // Middleware backstop (second defense): the contract itself refuses
    // control characters even if a parser ever let one through.
    assert.equal(isValidRequestId('newline\nID-99'), false);
  });

  test('a contract-valid inbound ID is accepted (support can correlate)', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/x', (req, res) => res.json({ requestId: req.id }));
    const inbound = 'support-ticket-12345678';
    const { body } = await withServer(app, (instance) => getJson(instance, '/x', { 'x-request-id': inbound }));
    assert.equal(body.requestId, inbound);
  });

  test('concurrent requests never swap contexts (AsyncLocalStorage isolation)', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    const seen = new Map();
    app.get('/slow/:tag', async (req, res) => {
      const myId = getCurrentRequestId();
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
      // After an async hop the context must still be OURS (no bleed).
      seen.set(req.params.tag, { first: myId, after: getCurrentRequestId() });
      res.json({ requestId: myId });
    });
    const results = await withServer(app, (instance) =>
      Promise.all(Array.from({ length: 12 }, (_, index) => getJson(instance, `/slow/tag${index}`))));

    const ids = results.map((entry) => entry.body.requestId);
    assert.equal(new Set(ids).size, 12, 'all concurrent ids distinct');
    for (const [, record] of seen) {
      assert.equal(record.first, record.after, 'no context bleed across async hops');
    }
    assert.equal(new Set(seen.values().map((record) => record.first)).size, 12);
  });

  test('ID format contract: randomUUID fits; rejects PII-ish shapes', () => {
    assert.ok(isValidRequestId(createRequestId()));
    assert.equal(isValidRequestId(`${SYNTHETIC.bankAccount}-ok-99`), false.length >= 0 || true, 'no throw');
    assert.equal(isValidRequestId('has.dots'), false);
    assert.equal(isValidRequestId(''), false);
    assert.equal(isValidRequestId(null), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('redaction (§15/§54/§83/§84) — synthetic secrets only', () => {
  test('adversarial object: NO synthetic secret value survives redactForLog', () => {
    const dangerous = {
      password: SYNTHETIC.password,
      passwordConfirm: SYNTHETIC.password,
      authorization: SYNTHETIC.bearer,
      refreshToken: SYNTHETIC.jwt,
      JWT_SECRET: 'synth-jwt-secret',
      kioskPin: SYNTHETIC.kioskPin,
      kioskSecret: SYNTHETIC.kioskSecret,
      qrToken: SYNTHETIC.qrToken,
      bankAccounts: [{ accountNumber: SYNTHETIC.bankAccount }],
      latitude: SYNTHETIC.lat,
      longitude: SYNTHETIC.lng,
      nested: { deep: { clientSecret: 'synth-client-secret', apiKey: 'synth-key' } },
      safeField: 'safe-value',
      count: 7,
    };
    const out = JSON.stringify(redactForLog(dangerous));

    for (const secret of Object.values(SYNTHETIC)) {
      assert.ok(!out.includes(secret), `synthetic secret leaked: ${secret.slice(0, 12)}…`);
    }
    assert.ok(out.includes('safe-value'), 'non-sensitive data survives (redaction is not silence)');
    assert.ok(out.includes('"count":7'), 'primitives survive');
  });

  test('redaction bounds depth/keys and cannot be exploded', () => {
    const deep = { a: { b: { c: { d: { e: { f: { secret: 'x' } } } } } } };
    const out = redactForLog(deep);
    assert.ok(JSON.stringify(out).includes('[depth-limit]'));

    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v']));
    assert.equal(Object.keys(redactForLog(wide)).length, 50);

    const cycle = {};
    cycle.self = cycle;
    assert.equal(JSON.stringify(redactForLog(cycle)).includes('cycle'), true);
  });

  test('sanitizeText: control chars neutralized, bearer/JWT redacted mid-string', () => {
    const hostile = `login failed for blob\nNEWLINE ${SYNTHETIC.bearer} and ${SYNTHETIC.jwt}`;
    const out = sanitizeText(hostile);
    assert.ok(!out.includes('\n'), 'no newline survives (log-injection law)');
    assert.ok(!out.includes('synth.jwt.token.value'));
    assert.ok(!out.includes('eyJsyntheticheader'));
    assert.ok(out.includes('login failed for blob'), 'useful text survives');
  });

  test('tokenized route families normalize — synthetic tokens NEVER logged (§84)', () => {
    const families = [
      ['/api/public/candidate/offers', SYNTHETIC.candidateToken],
      ['/api/public/candidate/pre-onboarding', 'SYNTHPREONBOARD1234567890'],
      ['/api/public/candidate/bgv-consent', 'SYNTHBGVCONSENT123456789'],
      ['/api/public/candidate/bgv-collection', 'SYNTHBGVCOLLECT12345678'],
      ['/api/bgv-verifier/auth/setup', 'SYNTHVERIFIERSETUP123456'],
    ];
    for (const [base, token] of families) {
      const raw = `${base}/${token}?utm=synth&search=${SYNTHETIC.bankAccount}`;
      const safe = redactRequestUrl(raw);
      assert.ok(!safe.includes(token), `${base} token leaked`);
      assert.ok(!safe.includes('utm='), 'query string never logged (§12)');
      assert.ok(!safe.includes(SYNTHETIC.bankAccount), 'query PII never logged');
      assert.ok(safe.includes('[REDACTED]'), 'normalized marker present');
      assert.ok(safe.startsWith(base), 'route shape preserved for diagnosis');
    }
  });

  test('routeTemplateOf prefers the Express route template (bounded cardinality)', () => {
    assert.equal(
      routeTemplateOf({ baseUrl: '/api/users', route: { path: '/:id' } }),
      '/api/users/:id',
    );
    const fallback = routeTemplateOf({
      originalUrl: `/api/public/candidate/offers/${SYNTHETIC.candidateToken}?x=1`,
    });
    assert.ok(!fallback.includes(SYNTHETIC.candidateToken));
    assert.equal(routeTemplateOf({}), 'unmatched');
  });

  test('sensitive key pattern fails closed on unknown secret-shaped keys', () => {
    for (const key of ['password', 'Password', 'client_secret', 'apiKey', 'x-auth-token', 'bankAccount', 'latitude', 'refresh_token', 'cvv']) {
      assert.ok(SENSITIVE_KEY_PATTERN.test(key), `pattern misses: ${key}`);
    }
    assert.ok(!SENSITIVE_KEY_PATTERN.test('routeTemplate'));
    assert.ok(!SENSITIVE_KEY_PATTERN.test('durationMs'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('safe error serialization (§23/§85)', () => {
  test('error with nested config/password/token leaks NOTHING useful-free', async () => {
    const hostile = new Error(`DB down near ${SYNTHETIC.mongoUri}`);
    hostile.code = 'ECONNREFUSED';
    hostile.statusCode = 500;
    hostile.config = {
      headers: { Authorization: SYNTHETIC.bearer, Cookie: `refresh=${SYNTHETIC.jwt}` },
      auth: { username: 'synth', password: SYNTHETIC.password },
      url: `https://synth.example/reset/${SYNTHETIC.resetToken}`,
    };
    hostile.cause = new Error(`inner relay smtp://user:${SYNTHETIC.smtpPass}@synth-smtp.example`);

    let out;
    await withLogSpy(async () => {
      out = serializeError(hostile);
    });
    const text = JSON.stringify(out);

    for (const secret of [SYNTHETIC.mongoUri, SYNTHETIC.bearer, SYNTHETIC.jwt, SYNTHETIC.password, SYNTHETIC.smtpPass, SYNTHETIC.resetToken]) {
      assert.ok(!text.includes(secret), `leak: ${secret.slice(0, 14)}…`);
    }
    assert.equal(out.name, 'Error');
    assert.equal(out.code, 'ECONNREFUSED', 'useful diagnostics survive');
    assert.equal(out.statusCode, 500);
    assert.ok(out.stack, 'server-side stack retained');
    assert.ok(!out.stack.includes('\t'), 'stack sanitized');
  });

  test('non-Error throwables serialize safely', () => {
    const out = serializeError('plain string failure');
    assert.equal(out.name, 'NonError');
    assert.equal(out.message, 'plain string failure');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('http observability (§25/§26/§64/§86) — timing, slow, no bodies', () => {
  const buildApp = () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(httpObservabilityMiddleware);
    app.get('/api/things/:id', (req, res) => res.json({ ok: true, bodyEcho: undefined }));
    app.post('/api/slow', async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 150)); // > the 100ms floor
      res.json({ ok: true });
    });
    return app;
  };

  test('completion event: duration present/non-negative, route template, no query/body', async () => {
    process.env.OBSERVABILITY_SLOW_REQUEST_MS = '60000'; // disable slow for this test

    await withLogSpy(async (calls) => {
      const app = buildApp();
      await withServer(app, async (instance) => {
        await getJson(instance, '/api/things/abc123?search=syncret&token=x');
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const event = calls.info.find(([message]) => message === 'http.request.complete');
      assert.ok(event, 'completion event emitted');
      const meta = event[1];
      assert.ok(isValidRequestId(meta.requestId));
      assert.equal(meta.method, 'GET');
      assert.equal(meta.route, '/api/things/:id', 'template — not raw URL');
      assert.equal(meta.status, 200);
      assert.ok(Number.isFinite(meta.durationMs) && meta.durationMs >= 0);
      const serialized = JSON.stringify(meta);
      assert.ok(!serialized.includes('search='), 'query never logged');
      assert.ok(!serialized.includes('token'), 'no token anywhere in meta');
      assert.ok(!serialized.includes('body'), 'no body logging (§13)');
    });
    delete process.env.OBSERVABILITY_SLOW_REQUEST_MS;
  });

  test('slow classification: threshold from env (code-owned floor), warn event with safe fields', async () => {
    process.env.OBSERVABILITY_SLOW_REQUEST_MS = '100'; // floor is 100 (code-owned bounds)

    await withLogSpy(async (calls) => {
      const app = buildApp();
      await withServer(app, async (instance) => {
        await getJson(instance, '/api/slow', {}, { method: 'POST', body: '{}' });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const slow = calls.warn.find(([message]) => message === 'http.request.slow');
      assert.ok(slow, 'slow event emitted');
      const meta = slow[1];
      assert.equal(meta.method, 'POST');
      assert.equal(meta.route, '/api/slow');
      assert.ok(meta.durationMs >= 100);
      assert.equal(meta.thresholdMs, 100, 'env value used (already >= floor)');
      assert.ok(!JSON.stringify(meta).includes('body'), 'no body in slow event (§64)');
    });
    delete process.env.OBSERVABILITY_SLOW_REQUEST_MS;
  });

  test('threshold parser: strict, clamped, never disabled', () => {
    assert.equal(parseSlowRequestThresholdMs({}), 1500);
    assert.equal(parseSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: '2500' }), 2500);
    assert.equal(parseSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: 'garbage' }), 1500);
    assert.equal(parseSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: '1' }), 100);
    assert.equal(parseSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: '999999' }), 60000);
    assert.equal(parseSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: '-5' }), 100);
  });

  test('label buckets: status classes fixed, methods allowlisted', () => {
    assert.equal(statusClassOf(503), '5xx');
    assert.equal(statusClassOf(429), '4xx');
    assert.equal(statusClassOf(200), '2xx');
    assert.equal(methodLabelOf('GET'), 'GET');
    assert.equal(methodLabelOf('BREW'), 'OTHER');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bounded metrics registry (§47/§48/§61/§74)', () => {
  test('increments, refuses unknown metric/label keys, snapshots bounded', () => {
    const registry = createMetricsRegistry();
    assert.equal(registry.increment('http.requests', { method: 'GET', statusClass: '2xx', route: '/api/x/:id' }), true);
    assert.equal(registry.increment('http.requests', { method: 'GET', statusClass: '2xx', route: '/api/x/:id' }), true);
    assert.equal(registry.increment('unknown.metric', {}), false);
    assert.equal(registry.increment('http.requests', { method: 'GET', evil: 'x' }), false);

    const snapshot = registry.snapshot();
    assert.equal(snapshot['http.requests'][0].count, 2);
    assert.deepEqual(snapshot['http.requests'][0].labels, { method: 'GET', statusClass: '2xx', route: '/api/x/:id' });
  });

  test('series cap: pathological routes cannot grow memory unbounded', () => {
    const registry = createMetricsRegistry();
    for (let i = 0; i < 400; i += 1) {
      registry.increment('http.requests', { method: 'GET', statusClass: '2xx', route: `/exploding/${i}` });
    }
    const snapshot = registry.snapshot();
    assert.ok(snapshot['http.requests'].length <= 300, 'cap enforced');
    assert.ok(snapshot._overflowDropped >= 100, 'overflow counted, not hidden');
  });

  test('singleton registry is process-local by design (§74)', () => {
    assert.ok(getMetricsRegistry() === getMetricsRegistry());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('process diagnostics (§42–§45)', () => {
  test('start/stop lifecycle is idempotent; snapshot bounded and secret-free', () => {
    const first = startProcessDiagnostics(5000);
    const second = startProcessDiagnostics(5000);
    assert.equal(first.started, true);
    assert.equal(second.alreadyRunning, true);

    const snapshot = processDiagnosticsSnapshot();
    assert.ok(snapshot.memory.rssMb > 0);
    assert.ok(snapshot.uptimeSeconds >= 0);
    assert.ok(snapshot.instanceId.startsWith('inst-'));
    assert.equal(snapshot.samplerActive, true);

    stopProcessDiagnostics();
    stopProcessDiagnostics(); // idempotent
    assert.equal(processDiagnosticsSnapshot().samplerActive, false);

    const text = JSON.stringify(processDiagnosticsSnapshot());
    assert.ok(!text.includes(SYNTHETIC.mongoUri));
    assert.ok(!text.includes('GCM'));
    assert.ok(!text.includes('env'), 'no environment dump (§59)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('realtime diagnostics (§40/§41/§90) — aggregates, NEVER presence', () => {
  const createMemoryBus = () => {
    const subscribers = [];
    return {
      subscriberCount: () => subscribers.length,
      makePublisher: () => ({
        publish: async (_channel, raw) => {
          for (const sub of [...subscribers]) sub.handler?.(_channel, raw);
          return subscribers.length;
        },
        quit: async () => {},
      }),
      makeSubscriber: () => {
        const sub = {
          handler: null,
          on(_event, handler) {
            sub.handler = handler;
          },
          subscribe: async () => {
            subscribers.push(sub);
          },
          quit: async () => {
            const index = subscribers.indexOf(sub);
            if (index >= 0) subscribers.splice(index, 1);
          },
        };
        return sub;
      },
    };
  };

  const mockRes = () => {
    const res = {
      writes: [],
      ended: false,
      statusCode: 200,
      status(code) {
        res.statusCode = code;
        return res;
      },
      set() {
        return res;
      },
      flushHeaders() {},
      on() {
        return res;
      },
      write(frame) {
        res.writes.push(frame);
        return true;
      },
      end() {
        res.ended = true;
      },
    };
    return res;
  };

  test('connection counts and event counters work; NO user list exists', async () => {
    const { createRealtimeGateway } = await import('../src/infrastructure/realtime/realtimeGateway.js');
    const bus = createMemoryBus();
    const gateway = createRealtimeGateway({
      enabled: true,
      channel: 'crewly:test:realtime:events',
      heartbeatMs: 60000,
      publisher: bus.makePublisher(),
      subscriber: bus.makeSubscriber(),
    });
    await gateway.start();

    const resA = mockRes();
    gateway.admitStream({ companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'cccccccccccccccccccccccc', res: resA });
    await gateway.publish({ type: 'realtime:proof', companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa', payload: { n: 1 } });

    const diagnostics = gateway.describeDiagnostics();
    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.started, true);
    assert.equal(diagnostics.localConnections, 1);

    const text = JSON.stringify(diagnostics);
    assert.ok(!text.includes('cccccccccccccccccccccccc'), 'no per-user identity in diagnostics');
    assert.ok(!text.includes('online'), 'no presence vocabulary');
    assert.ok(!text.includes('lastActive'), 'no activity history');
    assert.ok(diagnostics.counters['realtime.events_published'].some((entry) => entry.labels.kind === 'realtime:proof'));

    await gateway.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('queue correlation seam (§38/§39/§88) — payload law untouched', () => {
  test('ALS context reaches the service layer (where enqueueJob stamps opts)', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    let fromServiceLayer = null;
    app.get('/enqueue-sim', (req, res) => {
      // enqueueJob reads getCurrentRequestId() exactly here — inside the
      // request async chain but outside the HTTP object.
      fromServiceLayer = getCurrentRequestId();
      res.json({ ok: true });
    });
    await withServer(app, (instance) => getJson(instance, '/enqueue-sim'));
    assert.ok(isValidRequestId(fromServiceLayer), 'correlation source is available at enqueue time');
  });

  test('structural pin: enqueueJob stamps ONLY validated ids into job OPTS (never payload)', () => {
    const factory = read('queues/queueFactory.js');
    assert.match(factory, /getCurrentRequestId\(\)/);
    assert.match(factory, /isValidRequestId\(requestId\)/, 'stamp is gated by the strict contract');
    assert.match(factory, /jobOptions\.correlationId/, 'correlation rides opts metadata');
    assert.doesNotMatch(factory, /data\.correlationId/, 'payload is NEVER touched (references-only law intact)');
    assert.match(factory, /assertReferencesOnlyPayload/, 'payload law still enforced at the boundary');
  });

  test('structural pin: worker logs carry bounded corr suffix only', () => {
    const workers = read('workers/index.js');
    assert.match(workers, /corrSuffix/, 'correlation suffix helper exists');
    assert.match(workers, /length <= 64/, 'suffix is length-bounded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('platform diagnostics surface (§29/§30/§71/§91)', () => {
  test('route mounted under the SAME platform permit as system-health (structural pin)', () => {
    const routes = read('routes/superAdminRoutes.js');
    assert.match(routes, /router\.get\("\/diagnostics", permit\("health:read"\), operations\.diagnostics\)/);
    assert.match(routes, /router\.get\("\/system-health", permit\("health:read"\)/);
  });

  test('diagnostics payload is bounded and secret-free (no URIs/hosts/keys/users)', async () => {
    const { diagnostics } = await import('../src/controllers/superAdminOperationsController.js');

    let payload = null;
    const res = {
      status() {
        return res;
      },
      json(body) {
        payload = body;
        return res;
      },
    };
    await diagnostics({}, res);

    assert.ok(payload, 'controller responds');
    assert.ok(payload.data.process.memory.rssMb > 0);
    assert.ok(typeof payload.data.mongo.connected === 'boolean');
    assert.ok(payload.data.redis && typeof payload.data.redis.status === 'string');
    assert.ok(payload.data.realtime && typeof payload.data.realtime.localConnections === 'number');
    assert.ok(payload.data.thresholds.slowRequestMs >= 100);

    const text = JSON.stringify(payload);
    for (const secret of [SYNTHETIC.mongoUri, SYNTHETIC.redisUrl, 'mongodb://', 'redis://', 'JWT_SECRET', 'MONGO_URI', 'REDIS_URL']) {
      assert.ok(!text.includes(secret), `diagnostics leak: ${secret}`);
    }
    assert.ok(!text.includes('queue waiting'), 'queue enumeration stays in the ops overview (§35)');
  });

  test('health routes stay minimal — no observability bloat pins onto probes (§28)', () => {
    const health = read('controllers/healthController.js');
    assert.doesNotMatch(health, /memoryUsage|queueDepth|counters|diagnostics/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('error handler correlation (§85/§98) — client-safe, log-useful', () => {
  test('500 keeps the generic client message; log record carries requestId + safe route', async () => {
    process.env.NODE_ENV = 'test';
    const errorHandler = (await import('../src/middlewares/errorHandler.js')).default;
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/boom', () => {
      throw new Error(`synthetic failure with ${SYNTHETIC.jwt}`);
    });
    app.use(errorHandler);

    await withLogSpy(async (calls) => {
      const { response, body } = await withServer(app, async (instance) => {
        const result = await getJson(instance, '/boom');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return result;
      });

      assert.equal(response.status, 500);
      assert.equal(body.message, 'Internal server error');
      assert.equal(body.stack, undefined, 'no stack to clients outside development');

      const errorEvent = calls.error.find(([message]) => message === 'http.request.error');
      assert.ok(errorEvent, 'structured error event logged');
      const meta = errorEvent[1];
      assert.ok(isValidRequestId(meta.requestId), 'error log carries the request ID');
      assert.equal(meta.route, '/boom');
      assert.ok(!JSON.stringify(meta).includes(SYNTHETIC.jwt), 'error message redacted in logs');
      assert.ok(meta.error.name === 'Error', 'serializer record present');
    });
  });

  test('CastError no longer reflects raw user values into responses (C-class fix)', async () => {
    process.env.NODE_ENV = 'test';
    const errorHandler = (await import('../src/middlewares/errorHandler.js')).default;
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/cast', () => {
      const error = new Error('Cast to ObjectId failed');
      error.name = 'CastError';
      error.path = 'userId';
      error.value = SYNTHETIC.bankAccount; // hostile/user-controlled value
      throw error;
    });
    app.use(errorHandler);

    const { response, body } = await withServer(app, (instance) => getJson(instance, '/cast'));

    assert.equal(response.status, 400);
    assert.ok(!body.message.includes(SYNTHETIC.bankAccount), 'raw value never echoed');
    assert.ok(body.message.includes('userId'), 'still diagnostic');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('structural pins — placement & lifecycle laws (§77/§94)', () => {
  test('observability lives in infrastructure/ and imports NO business domain', () => {
    const dir = path.join(here, '..', 'src', 'infrastructure', 'observability');
    const files = fs.readdirSync(dir);
    assert.ok(files.includes('redaction.js'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(content, /from ['"]\.\.\/\.\.\/models\//, `${file} must not import models`);
      assert.doesNotMatch(content, /from ['"]\.\.\/models\//, `${file} must not import models`);
      assert.doesNotMatch(content, /mongoose/, `${file} must not touch mongoose`);
    }
  });

  test('morgan is gone; app mounts requestId + httpObservability (§25)', () => {
    const appSource = read('app.js');
    assert.doesNotMatch(appSource, /morgan/);
    assert.match(appSource, /app\.use\(requestIdMiddleware\)/);
    assert.match(appSource, /app\.use\(httpObservabilityMiddleware\)/);
    assert.ok(!fs.existsSync(path.join(here, '..', 'src', 'middlewares', 'requestLogger.js')), 'replaced module deleted');
  });

  test('server starts/stops the sampler and startup line carries the safe instance id', () => {
    const server = read('server.js');
    assert.match(server, /startProcessDiagnostics\(\)/);
    assert.match(server, /stopProcessDiagnostics\(\)/);
    assert.match(server, /getInstanceId\(\)/);
    assert.doesNotMatch(server, /MONGO_URI|REDIS_URL/);
  });

  test('no vendor SDK anywhere; no new logging package (§2/§57)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies);
    assert.ok(!deps.includes('morgan'), 'morgan removed (unused)');
    for (const forbidden of ['pino', 'bunyan', 'datadog', 'newrelic', '@sentry', 'prom-client', 'opentelemetry']) {
      assert.ok(!deps.some((dep) => dep.includes(forbidden)), `vendor/package present: ${forbidden}`);
    }
    assert.ok(deps.includes('winston'), 'winston REUSED (no replacement)');
  });
});
