// ============================================================
//  PHASE 32.3 — LOAD BALANCER & REVERSE PROXY READINESS (HERMETIC).
//
//  Proves the central security property and the test matrix:
//
//    A  default direct request → socket identity
//    B  FORGED X-Forwarded-For (direct) → NOT trusted
//    C  trusted proxy (declared boundary) → forwarded client honored
//    D  forwarded chain (multiple addresses) → Express hop semantics
//    E  FORGED X-Forwarded-Proto (direct) → not secure
//    F  trusted HTTPS termination (loopback proxy) → secure
//    G/H  CORS allowed / disallowed origins (real app)
//    I  health probes through proxy behavior (real app)
//    J  configuration determinism across instances
//    K  no secrets/topology in health output under forged headers
//
//  The REAL shipped applyProxyTrust + getRequestIp run everywhere.
//  Per-mode Express semantics run on scratch express apps (the trust
//  setting is applied at app-construction time); the real app.js is
//  integration-tested in its default mode. No Mongo, no Redis, no
//  external proxy.
// ============================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const { default: express } = await import('express');
const proxyTrust = await import('../src/config/proxyTrust.js');
const securityPolicy = await import('../src/utils/securityPolicy.js');

const { parseProxyTrustConfig, applyProxyTrust } = proxyTrust;
const { getRequestIp } = securityPolicy;

// Listen helper: ephemeral port, real sockets, real fetch.
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve(server),
    );
  });

const get = async (port, path = '/', headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { connection: 'close', ...headers },
  });

  return { status: res.status, headers: res.headers, body: await res.json() };
};

// server.close() waits for open sockets — undici keeps keep-alive
// sockets open, so tests close idle sockets explicitly first (the
// exact keep-alive behavior §13 of the brief calls out).
const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeIdleConnections?.();

    server.close(() => resolve());
  });

// Scratch app exposing exactly the identity surface under test.
const probeApp = (source) => {
  const app = express();

  applyProxyTrust(app, source);

  app.get('/', (req, res) => {
    res.json({
      ip: req.ip,
      ips: req.ips,
      protocol: req.protocol,
      secure: req.secure,
      hostname: req.hostname,
    });
  });

  return app;
};

const LOOPBACK_SOCKET = '127.0.0.1';

// ═════════════════════════════════════════════════════════════
//  Configuration parser (strict, fail-fast)
// ═════════════════════════════════════════════════════════════

test('config: default is DIRECT (no trust) with zero environment variables', () => {
  const config = parseProxyTrustConfig({});

  assert.equal(config.mode, 'direct');
  assert.equal(config.trust, false);
});

test('config: loopback / hop / cidr parse; hops clamp; invalid values FAIL LOUDLY', () => {
  assert.equal(parseProxyTrustConfig({ TRUST_PROXY_MODE: 'loopback' }).trust, 'loopback');

  const hop = parseProxyTrustConfig({ TRUST_PROXY_MODE: 'hop', TRUST_PROXY_HOPS: '2' });
  assert.equal(hop.trust, 2);

  assert.equal(
    parseProxyTrustConfig({ TRUST_PROXY_MODE: 'hop', TRUST_PROXY_HOPS: '99' }).trust,
    10,
    'hops clamped to maximum',
  );
  assert.equal(
    parseProxyTrustConfig({ TRUST_PROXY_MODE: 'hop', TRUST_PROXY_HOPS: '0' }).trust,
    1,
    'hops clamped to minimum',
  );

  const cidr = parseProxyTrustConfig({
    TRUST_PROXY_MODE: 'cidr',
    TRUST_PROXY_CIDRS: ' 10.0.0.0/8, 192.168.1.1, ::1 ',
  });
  assert.equal(cidr.trust, '10.0.0.0/8, 192.168.1.1, ::1');

  assert.throws(
    () => parseProxyTrustConfig({ TRUST_PROXY_MODE: 'true' }),
    /invalid/,
    'the dangerous blanket-true style value must never be accepted',
  );
  assert.throws(
    () => parseProxyTrustConfig({ TRUST_PROXY_MODE: 'hop', TRUST_PROXY_HOPS: 'abc' }),
    /not a number/,
  );
  assert.throws(
    () => parseProxyTrustConfig({ TRUST_PROXY_MODE: 'cidr', TRUST_PROXY_CIDRS: 'not-an-ip' }),
    /invalid entry/,
  );
  assert.throws(
    () => parseProxyTrustConfig({ TRUST_PROXY_MODE: 'cidr' }),
    /required/,
  );
});

// ═════════════════════════════════════════════════════════════
//  A/B/E — DEFAULT DIRECT: spoofing is inert
// ═════════════════════════════════════════════════════════════

test('A: default direct request → identity is the socket address', async () => {
  const server = await listen(probeApp({}));
  try {
    const { body } = await get(server.address().port);

    assert.equal(body.ip, LOOPBACK_SOCKET);
    assert.deepEqual(body.ips, []);
    assert.equal(body.protocol, 'http');
    assert.equal(body.secure, false);
  } finally {
    await closeServer(server);
  }
});

test('B: FORGED X-Forwarded-For on a direct request must NOT become trusted identity', async () => {
  const server = await listen(probeApp({}));
  try {
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-for': '8.8.8.8, 1.2.3.4',
    });

    assert.equal(
      body.ip,
      LOOPBACK_SOCKET,
      'attacker-chosen forwarded IP must never become req.ip untrusted',
    );
    assert.deepEqual(body.ips, []);
  } finally {
    await closeServer(server);
  }
});

test('E: FORGED X-Forwarded-Proto on a direct request must NOT make the request secure', async () => {
  const server = await listen(probeApp({}));
  try {
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-proto': 'https',
    });

    assert.equal(body.protocol, 'http');
    assert.equal(body.secure, false);
  } finally {
    await closeServer(server);
  }
});

// ═════════════════════════════════════════════════════════════
//  C/D/F — DECLARED TRUSTED BOUNDARY: forwarded info honored
// ═════════════════════════════════════════════════════════════

test('C: loopback proxy declared → forwarded client IP honored (loopback socket is the proxy)', async () => {
  const server = await listen(probeApp({ TRUST_PROXY_MODE: 'loopback' }));
  try {
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-for': '203.0.113.7',
    });

    assert.equal(body.ip, '203.0.113.7');
    assert.deepEqual(body.ips, ['203.0.113.7']);
  } finally {
    await closeServer(server);
  }
});

test('D: forwarded chain — hop 1 counts the socket proxy; req.ip = rightmost XFF entry (nginx/Render append semantics)', async () => {
  const server = await listen(
    probeApp({ TRUST_PROXY_MODE: 'hop', TRUST_PROXY_HOPS: '1' }),
  );
  try {
    // One proxy (10.0.0.9) sits directly in front of the API and
    // appended the client address it saw: XFF = "client, proxy".
    // Express hop counts FROM the socket: hop 1 = the socket proxy,
    // so req.ip = the rightmost (newest) forwarded entry.
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-for': '203.0.113.7, 10.0.0.9',
    });

    assert.equal(body.ip, '10.0.0.9');
    // req.ips carries the trusted-hop slice of the chain.
    assert.deepEqual(body.ips, ['10.0.0.9']);
  } finally {
    await closeServer(server);
  }
});

test('D: forwarded chain — hop 2 (CDN + LB in front of the API) resolves the real client', async () => {
  const server = await listen(
    probeApp({ TRUST_PROXY_MODE: 'hop', TRUST_PROXY_HOPS: '2' }),
  );
  try {
    // Chain: client(203.0.113.7) → CDN → LB(10.0.0.9) → API(socket):
    // XFF carries [client, cdn]. Two proxy hops → req.ip = client.
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-for': '203.0.113.7, 198.51.100.5',
    });

    assert.equal(body.ip, '203.0.113.7');
  } finally {
    await closeServer(server);
  }
});

test('C: cidr boundary — proxy IN the trusted network honored', async () => {
  const server = await listen(
    probeApp({
      TRUST_PROXY_MODE: 'cidr',
      TRUST_PROXY_CIDRS: '10.0.0.0/8, 127.0.0.0/8',
    }),
  );
  try {
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-for': '198.51.100.23',
    });

    assert.equal(body.ip, '198.51.100.23');
  } finally {
    await closeServer(server);
  }
});

test('C: cidr boundary — proxy OUTSIDE the trusted network → headers ignored (direct fallback)', async () => {
  const server = await listen(
    probeApp({
      TRUST_PROXY_MODE: 'cidr',
      TRUST_PROXY_CIDRS: '10.0.0.0/8',
    }),
  );
  try {
    // The socket (127.0.0.1) is NOT a declared proxy → forwarded data
    // is untrusted even though the header is present.
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-for': '198.51.100.23',
    });

    assert.equal(body.ip, LOOPBACK_SOCKET);
  } finally {
    await closeServer(server);
  }
});

test('F: trusted HTTPS termination — external HTTPS → internal HTTP is correctly interpreted', async () => {
  const server = await listen(probeApp({ TRUST_PROXY_MODE: 'loopback' }));
  try {
    const { body } = await get(server.address().port, '/', {
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.7',
    });

    assert.equal(body.protocol, 'https');
    assert.equal(body.secure, true);
  } finally {
    await closeServer(server);
  }
});

// ═════════════════════════════════════════════════════════════
//  getRequestIp — trust-aware identity for audit/security records
// ═════════════════════════════════════════════════════════════

test('getRequestIp: uses req.ip (trust-aware) — forged X-Forwarded-For can NEVER win directly', () => {
  // Untrusted/direct topology: Express set req.ip to the socket.
  assert.equal(
    getRequestIp({
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '8.8.8.8' },
      socket: { remoteAddress: '127.0.0.1' },
    }),
    '127.0.0.1',
    'hand-parsed XFF must not bypass the trust boundary',
  );

  // Trusted topology: Express derived the real client from the chain.
  assert.equal(
    getRequestIp({
      ip: '203.0.113.7',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    }),
    '203.0.113.7',
  );

  // Degraded fallbacks.
  assert.equal(getRequestIp({ socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(getRequestIp({}), '');
});

// ═════════════════════════════════════════════════════════════
//  Real app integration: default mode, health probes, CORS
// ═════════════════════════════════════════════════════════════

const appModule = await import('../src/app.js');
const realApp = appModule.default;

test('I + K (real app): health probes work under forged proxy headers; output stays secret-free', async () => {
  const server = await listen(realApp);
  try {
    const port = server.address().port;

    const live = await get(port, '/api/health/live', {
      'x-forwarded-for': '8.8.8.8',
      'x-forwarded-proto': 'https',
    });

    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'ok');

    const ready = await get(port, '/api/health/ready', {
      'x-forwarded-for': '8.8.8.8',
    });

    // Startup lifecycle of a fresh import is STARTING → 503 is the
    // CORRECT Phase 32.2 semantics; assert the contract, not luck.
    assert.ok([200, 503].includes(ready.status));
    assert.ok(ready.body.status === 'ready' || ready.body.status === 'unready');

    const raw = JSON.stringify({ live: live.body, ready: ready.body });

    for (const word of ['mongodb://', 'redis://', 'password', 'secret']) {
      assert.ok(!raw.toLowerCase().includes(word));
    }
  } finally {
    await closeServer(server);
  }
});

test('G + H (real app): CORS allows the configured origin; disallowed origin gets no permissive headers', async () => {
  const server = await listen(realApp);
  try {
    const port = server.address().port;

    const allowed = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
      headers: { origin: 'http://localhost:5173', connection: 'close' },
    });

    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
    );

    const disallowed = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
      headers: { origin: 'https://attacker.example', connection: 'close' },
    });

    assert.equal(
      disallowed.headers.get('access-control-allow-origin'),
      null,
      'unauthorized origin must not receive permissive CORS headers',
    );

    // Preflight from a disallowed origin is refused.
    const preflight = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
        connection: 'close',
      },
    });

    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      null,
    );
  } finally {
    await closeServer(server);
  }
});

// ═════════════════════════════════════════════════════════════
//  J — multi-instance determinism + wiring pins
// ═════════════════════════════════════════════════════════════

test('J: identical env → identical trust config (both instances interpret the same way)', () => {
  const env = { TRUST_PROXY_MODE: 'hop', TRUST_PROXY_HOPS: '1' };

  assert.deepEqual(
    parseProxyTrustConfig(env),
    parseProxyTrustConfig({ ...env }),
  );
  assert.deepEqual(
    parseProxyTrustConfig({}),
    parseProxyTrustConfig({}),
  );
});

test('wiring pins: app.js uses the central applier; no hard-coded trust value remains', async () => {
  const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

  assert.match(appSource, /applyProxyTrust\(app\)/);
  assert.doesNotMatch(
    appSource,
    /app\.set\(\s*'trust proxy'/,
    'trust must be configured ONLY through config/proxyTrust.js',
  );

  const policySource = await readFile(
    new URL('../src/utils/securityPolicy.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    policySource,
    /headers\[\s*['"]x-forwarded-for['"]\s*\]/i,
    'client IP must never be hand-parsed from forwarded headers outside Express semantics',
  );
});

// The real-app import graph (routes → services → config modules) leaves
// benign process handles open (loggers/agents). Test assertions are
// complete at this point — end the test process deterministically.
test.after(() => {
  setTimeout(() => process.exit(0), 100).unref();
});
