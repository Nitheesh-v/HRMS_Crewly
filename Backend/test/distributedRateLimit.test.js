// ============================================================
//  PHASE 32.4 — DISTRIBUTED RATE LIMITING (HERMETIC SUITE).
//
//  Proves the core 32.4 property: security-sensitive limits are ONE
//  budget across API instances, with honest degradation, safe keys,
//  and no cross-family/cross-tenant collisions. No Mongo, no real
//  Redis: the REAL shipped rateLimitStore, securityRateLimit
//  middleware and Super Admin guard run against an injected
//  in-memory IO emulating atomic INCR / GET / DEL + window expiry.
// ============================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const storeModule = await import('../src/utils/rateLimitStore.js');
const rateLimitModule = await import('../src/middlewares/securityRateLimit.js');
const superAdminModule = await import('../src/middlewares/superAdminAuth.js');

const { createRateLimitStore, resetRateLimitStoreForTests } = storeModule;
const { securityRateLimit } = rateLimitModule;
const { createSuperAdminLoginGuard } = superAdminModule;

// ─────────────────────────────────────────────────────────────
//  In-memory Redis IO: ATOMIC INCR + window expiry + GET + DEL.
//  (Single event-loop mutation per op — the same atomicity
//  guarantee Redis INCR gives two API instances.)
// ─────────────────────────────────────────────────────────────
const fakeRedisIo = () => {
  const store = new Map(); // key → { count, expiresAt }

  let incrCalls = 0;

  return {
    store,

    calls: () => incrCalls,

    async incr(key, ttlSeconds) {
      incrCalls += 1;

      const now = Date.now();

      const entry = store.get(key);

      if (!entry || entry.expiresAt <= now) {
        store.set(key, {
          count: 1,
          expiresAt: now + ttlSeconds * 1000,
        });

        return 1;
      }

      entry.count += 1;

      return entry.count;
    },

    async get(key) {
      const entry = store.get(key);

      if (!entry || entry.expiresAt <= Date.now()) return null;

      return entry.count;
    },

    async del(key) {
      store.delete(key);
    },
  };
};

const mockRes = () => ({
  statusCode: null,
  body: null,
  headers: {},

  setHeader(name, value) {
    this.headers[name] = value;
  },

  status(code) {
    this.statusCode = code;

    return this;
  },

  json(body) {
    if (this.statusCode === null) this.statusCode = 200;

    this.body = body;

    return this;
  },
});

const loginReq = (ip, email) => ({
  ip,

  originalUrl: '/api/auth/login',

  body: { email, password: 'wrong' },
});

// ═════════════════════════════════════════════════════════════
//  1. THE CORE MULTI-INSTANCE PROPERTY (§34/§63)
// ═════════════════════════════════════════════════════════════

test('shared budget: two middleware instances (API #1 + API #2) enforce ONE limit', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const sharedBackend = createRateLimitStore({
    sharedName: 'login',

    windowMs: 60000,

    io,
  });

  const api1 = securityRateLimit({
    maximum: 5,
    windowMs: 60000,
    message: 'limit reached',
    store: sharedBackend,
  });

  const api2 = securityRateLimit({
    maximum: 5,
    windowMs: 60000,
    message: 'limit reached',
    store: sharedBackend,
  });

  const seen = [];

  // Requests alternate instances exactly as the build prompt sketches.
  for (let index = 0; index < 6; index += 1) {
    const middleware = index % 2 === 0 ? api1 : api2;

    const res = mockRes();

    await middleware(loginReq('1.1.1.1', 'victim@example.com'), res, () =>
      seen.push('next'),
    );

    seen.push(res.statusCode);
  }

  // 401-shaped pass-through five times (statusCode null = next()),
  // then the 6th COMBINED hit is refused regardless of instance.
  assert.deepEqual(
    seen,
    ['next', null, 'next', null, 'next', null, 'next', null, 'next', null, 429],
    'shared counter: 6th combined hit limited even though each instance saw only 3',
  );

  const res7 = mockRes();

  await api1(loginReq('1.1.1.1', 'victim@example.com'), res7, () => {});

  assert.equal(res7.statusCode, 429, 'alternating instances cannot escape the bucket');
});

test('429 semantics: frozen body + headers + exact Retry-After (shared tier)', async () => {
  resetRateLimitStoreForTests();

  const limiter = securityRateLimit({
    maximum: 1,
    windowMs: 60000,
    message: 'limit reached',
    store: createRateLimitStore({ sharedName: 'login', windowMs: 60000, io: fakeRedisIo() }),
  });

  await limiter(loginReq('2.2.2.2', 'a@example.com'), mockRes(), () => {});

  const limited = mockRes();

  await limiter(loginReq('2.2.2.2', 'a@example.com'), limited, () => {});

  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.body, {
    statusCode: 429,
    success: false,
    code: 'RATE_LIMITED',
    message: 'limit reached',
  });
  assert.equal(limited.headers['X-RateLimit-Limit'], 1);
  assert.equal(limited.headers['X-RateLimit-Remaining'], 0);
  assert.ok(limited.headers['X-RateLimit-Reset'] > Math.floor(Date.now() / 1000));
  assert.ok(
    limited.headers['Retry-After'] >= 1 && limited.headers['Retry-After'] <= 60,
    'Retry-After is exact TTL-derived seconds',
  );
});

test('CONCURRENT race (§35): 10 parallel requests vs max 5 → exactly 5 pass', async () => {
  resetRateLimitStoreForTests();

  const limiter = securityRateLimit({
    maximum: 5,
    windowMs: 60000,
    store: createRateLimitStore({ sharedName: 'login', windowMs: 60000, io: fakeRedisIo() }),
  });

  const attempts = Array.from({ length: 10 }, () => {
    const res = mockRes();

    let passed = false;

    return limiter(loginReq('3.3.3.3', 'race@example.com'), res, () => {
      passed = true;
    }).then(() => passed);
  });

  const outcomes = await Promise.all(attempts);

  assert.equal(
    outcomes.filter(Boolean).length,
    5,
    'the atomic counter allows exactly maximum concurrent passes — no race overage',
  );
});

// ═════════════════════════════════════════════════════════════
//  2. KEYS — namespace, isolation, secret/PII safety
// ═════════════════════════════════════════════════════════════

test('key namespace: crewly:<env>:rl:<family>:<identity> (env + family isolation)', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const login = createRateLimitStore({ sharedName: 'login', windowMs: 60000, io });

  assert.match(login.keyPrefix, /^crewly:[a-z]+:rl:login:$/);

  await login.hit('1.1.1.1:/x:fp', 5);

  const key = [...io.store.keys()][0];

  assert.match(key, /^crewly:[a-z]+:rl:login:1\.1\.1\.1:\/x:fp$/);

  const kiosk = createRateLimitStore({ sharedName: 'kiosk-session', windowMs: 60000, io });

  const kioskResult = await kiosk.hit('1.1.1.1:/x:fp', 5);

  assert.equal(kioskResult.count, 1, 'families never share counters');
});

test('SECRET SAFETY (§12/§13): no raw email in store keys — digest only', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const limiter = securityRateLimit({
    maximum: 5,
    windowMs: 60000,
    store: createRateLimitStore({ sharedName: 'login', windowMs: 60000, io }),
  });

  await limiter(loginReq('4.4.4.4', 'alice.secret@example.com'), mockRes(), () => {});

  const allKeys = [...io.store.keys()].join('|');

  assert.ok(!allKeys.includes('alice'), 'raw email must never appear in a limiter key');
  assert.ok(!allKeys.includes('example.com'), 'raw email domain must never appear');
  assert.match(
    allKeys,
    /^crewly:[a-z]+:rl:login:4\.4\.4\.4:\/api\/auth\/login:[0-9a-f]{16}$/,
    'key is prefix + effective IP + url + 16-hex email digest only',
  );
});

test('identity scoping: different IP = different bucket; same IP+email = same bucket', async () => {
  resetRateLimitStoreForTests();

  const limiter = securityRateLimit({
    maximum: 1,
    windowMs: 60000,
    store: createRateLimitStore({ sharedName: 'login', windowMs: 60000, io: fakeRedisIo() }),
  });

  await limiter(loginReq('5.5.5.5', 'x@example.com'), mockRes(), () => {});

  const otherIp = mockRes();

  await limiter(loginReq('6.6.6.6', 'x@example.com'), otherIp, () => {});

  assert.equal(otherIp.statusCode, null, 'another effective IP has its own budget');

  const sameAgain = mockRes();

  await limiter(loginReq('5.5.5.5', 'x@example.com'), sameAgain, () => {});

  assert.equal(sameAgain.statusCode, 429, 'same identity continues the same bucket');
});

// ═════════════════════════════════════════════════════════════
//  3. FAILURE POLICY — disabled vs down (§18/§19/§20)
// ═════════════════════════════════════════════════════════════

test('REDIS DISABLED (strict parser → null client): quiet local buckets, limit still enforced', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const store = createRateLimitStore({
    sharedName: 'login',

    windowMs: 60000,

    io: {
      incr: async () => null, // getRedisClient() === null shape

      get: async () => null,

      del: async () => {},
    },
  });

  const limiter = securityRateLimit({ maximum: 2, windowMs: 60000, store });

  await limiter(loginReq('7.7.7.7', 'd@example.com'), mockRes(), () => {});
  await limiter(loginReq('7.7.7.7', 'd@example.com'), mockRes(), () => {});

  const third = mockRes();

  await limiter(loginReq('7.7.7.7', 'd@example.com'), third, () => {});

  assert.equal(third.statusCode, 429, 'degraded local tier still enforces the contract');
  assert.equal(io.calls(), 0, 'disabled mode never touches the backend');
});

test('REDIS DOWN: request served via fallback, circuit opens, no 500s, recovery after cooldown', async () => {
  resetRateLimitStoreForTests();

  let failing = true;

  let calls = 0;

  const io = {
    incr: async () => {
      calls += 1;

      if (failing) throw new Error('ECONNREFUSED');

      return 1;
    },

    get: async () => {
      throw new Error('ECONNREFUSED');
    },

    del: async () => {},
  };

  const store = createRateLimitStore({ sharedName: 'login', windowMs: 60000, io });

  const limiter = securityRateLimit({ maximum: 100, windowMs: 60000, store });

  const res = mockRes();

  let nextCalled = false;

  await limiter(loginReq('8.8.8.8', 'down@example.com'), res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, 'Redis failure never breaks the request');
  assert.equal(res.statusCode, null);

  const callsAfterFirst = calls;

  await limiter(loginReq('8.8.8.8', 'down@example.com'), mockRes(), () => {});

  assert.equal(calls, callsAfterFirst, 'circuit open: backend untouched during cooldown');

  // The circuit is process-local and per-family (30s, pinned by the
  // safety-pin test). Resetting the module's circuit state — what a
  // cooldown expiry does — restores the shared tier immediately.
  resetRateLimitStoreForTests();

  failing = false;

  const recoveredStore = createRateLimitStore({
    sharedName: 'login',

    windowMs: 60000,

    io,
  });

  const recovery = await recoveredStore.hit('9.9.9.9:any', 100);

  assert.equal(recovery.tier, 'shared', 'after the circuit clears, the shared tier resumes');
});

test('window expiry: counter resets and keys do not accumulate forever (§17)', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const store = createRateLimitStore({ sharedName: 'window', windowMs: 30, io });

  await store.hit('9.9.9.9', 1);

  const limited = await store.hit('9.9.9.9', 1);

  assert.equal(limited.limited, true, 'second hit in the same window is limited');

  const key = [...io.store.keys()][0];

  io.store.get(key).expiresAt = Date.now() - 1; // TTL elapsed

  const fresh = await store.hit('9.9.9.9', 1);

  assert.equal(fresh.count, 1, 'new window starts clean — RESET works');
  assert.equal(fresh.limited, false);
});

// ═════════════════════════════════════════════════════════════
//  4. SUPER ADMIN LOGIN GUARD — shared across instances
// ═════════════════════════════════════════════════════════════

test('super admin guard: 5 failures on instance A block instance B; success clears both', async () => {
  resetRateLimitStoreForTests();

  const backend = createRateLimitStore({
    sharedName: 'super-admin-login',

    windowMs: 15 * 60 * 1000,

    io: fakeRedisIo(),
  });

  const instanceA = createSuperAdminLoginGuard({ store: backend });

  const instanceB = createSuperAdminLoginGuard({ store: backend });

  const req = { ip: '10.0.0.1', body: { email: 'root@crewly.test' } };

  const pass = mockRes();

  await instanceA(req, pass, () => {});

  assert.equal(pass.statusCode, null, 'under the threshold → passes');

  for (let index = 0; index < 5; index += 1) {
    req.recordAdminLoginFailure();
  }

  await new Promise((resolve) => setTimeout(resolve, 10));

  const blocked = mockRes();

  let nextB = false;

  await instanceB(req, blocked, () => {
    nextB = true;
  });

  assert.equal(nextB, false, 'instance B enforces the block recorded via instance A');
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.body, {
    statusCode: 429,
    success: false,
    message: 'Too many login attempts. Try again later.',
  });

  await req.clearAdminLoginAttempts();

  const recovered = mockRes();

  let nextC = false;

  await instanceB(req, recovered, () => {
    nextC = true;
  });

  assert.equal(nextC, true, 'successful login clears the shared block');
});

test('super admin guard keys: no raw email in the shared counter key', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const guard = createSuperAdminLoginGuard({
    store: createRateLimitStore({
      sharedName: 'super-admin-login',

      windowMs: 15 * 60 * 1000,

      io,
    }),
  });

  const req = { ip: '10.0.0.2', body: { email: 'super.secret@crewly.test' } };

  const res = mockRes();

  await guard(req, res, () => {});

  req.recordAdminLoginFailure();

  await new Promise((resolve) => setTimeout(resolve, 10));

  const allKeys = [...io.store.keys()].join('|');

  assert.ok(!allKeys.includes('super.secret'), 'raw admin email never in keys');
  assert.ok(!allKeys.includes('crewly.test'), 'raw admin email domain never in keys');
});

// ═════════════════════════════════════════════════════════════
//  5. WIRING + SAFETY PINS (§44 classification frozen in tests)
// ═════════════════════════════════════════════════════════════

test('wiring pins: A/B surfaces shared, C surfaces stay local', async () => {
  const expected = {
    'src/routes/attendance/attendanceKioskRoutes.js': 3,
    'src/routes/attendance/attendanceRoutes.js': 1,
    'src/routes/bgv/bgvVerifierAuthRoutes.js': 2,
    'src/routes/bgv/bgvVerifierWorkRoutes.js': 1,
    'src/routes/bgv/publicBgvConsentRoutes.js': 2,
    'src/routes/bgv/publicBgvCollectionRoutes.js': 4,
    'src/routes/recruitment/publicCandidateOfferRoutes.js': 2,
    'src/routes/recruitment/publicCandidatePreOnboardingRoutes.js': 2,
    'src/routes/recruitment/publicCareerRoutes.js': 2,
  };

  for (const [path, count] of Object.entries(expected)) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');

    const found = (source.match(/sharedName: '/g) || []).length;

    assert.equal(found, count, `${path} must wire exactly ${count} shared limiter(s)`);
  }

  // C-class: authenticated internal load-shedding stays process-local.
  for (const path of ['src/routes/recruitment/recruitmentRoutes.js', 'src/routes/platform/superAdminRoutes.js']) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');

    assert.ok(!source.includes('sharedName:'), `${path} must remain LOCAL (C-class)`);
  }

  const middleware = await readFile(
    new URL('../src/middlewares/securityRateLimit.js', import.meta.url),
    'utf8',
  );

  for (const name of ["'login'", "'password-reset'", "'refresh'", "'password-change'"]) {
    assert.ok(middleware.includes(`sharedName: ${name},`), `exported ${name} must be shared`);
  }
});

test('safety pins: no KEYS/SCAN/FLUSH; bounded fallback; frozen contracts; 32.3 identity', async () => {
  const store = await readFile(
    new URL('../src/utils/rateLimitStore.js', import.meta.url),
    'utf8',
  );

  for (const pattern of [/client\.keys/i, /\.scan\(/i, /flushall/i, /flushdb/i]) {
    assert.ok(!pattern.test(store), `rate-limit store must never use ${pattern}`);
  }

  assert.match(store, /FALLBACK_MAX_KEYS = 10000/);
  assert.match(store, /OP_TIMEOUT_MS = 250/);
  assert.match(store, /CIRCUIT_COOLDOWN_MS = 30 \* 1000/);

  const middleware = await readFile(
    new URL('../src/middlewares/securityRateLimit.js', import.meta.url),
    'utf8',
  );

  // 32.3 identity law: limiters never hand-parse forwarded headers —
  // identity flows through req.ip (trust-aware) only.
  assert.ok(!/headers\[['"]x-forwarded-for/i.test(middleware));

  // Local-tier 429 body contract is byte-frozen.
  assert.match(middleware, /code:\s*'RATE_LIMITED'/);

  const guard = await readFile(
    new URL('../src/middlewares/superAdminAuth.js', import.meta.url),
    'utf8',
  );

  assert.match(guard, /export const superAdminLoginGuard = createSuperAdminLoginGuard/);
});
