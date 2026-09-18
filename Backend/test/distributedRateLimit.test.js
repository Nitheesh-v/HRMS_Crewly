// ============================================================
//  PHASE 32.4 — DISTRIBUTED RATE LIMITING (HERMETIC SUITE).
//
//  Proves the central property: security-sensitive limits are ONE
//  budget across API instances, with honest degradation and no
//  cross-surface/cross-tenant key collisions.
//
//  No Mongo, no real Redis. The REAL shipped rateLimitStore,
//  securityRateLimit dual-tier middleware and Super Admin guard run
//  against an injected in-memory IO that emulates INCR/EXPIRE/GET/DEL.
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
//  In-memory Redis IO: INCR (with window expiry), GET, DEL.
// ─────────────────────────────────────────────────────────────
const fakeRedisIo = () => {
  const store = new Map(); // key → { count, expiresAt }

  return {
    store,

    async incr(key, ttlSeconds) {
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

const reqFor = (identity, url = '/test') => ({
  ip: identity,

  originalUrl: url,

  body: {},
});

let SEQ = 0;

// ═════════════════════════════════════════════════════════════
//  THE central multi-instance property
// ═════════════════════════════════════════════════════════════

test('shared budget: two middleware instances (API #1 + API #2) enforce ONE limit', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const store = createRateLimitStore({
    sharedName: 'login-test',

    windowMs: 60000,

    io,
  });

  const api1 = securityRateLimit({
    maximum: 5,

    windowMs: 60000,

    message: 'limit reached',

    store,
  });

  const api2 = securityRateLimit({
    maximum: 5,

    windowMs: 60000,

    message: 'limit reached',

    store,
  });

  // maximum = 5 → the FIRST 5 combined hits pass, split across the
  // two instances; hit #6 — on EITHER instance — is refused.
  const results = [];

  for (let index = 0; index < 2; index += 1) {
    const res1 = mockRes();

    await api1(reqFor('1.1.1.1'), res1, () => results.push('next1'));

    const res2 = mockRes();

    await api2(reqFor('1.1.1.1'), res2, () => results.push('next2'));
  }

  // 5th combined hit (API #1) — still inside the shared budget.
  const fifth = mockRes();

  await api1(reqFor('1.1.1.1'), fifth, () => results.push('next1'));

  assert.deepEqual(
    results,
    ['next1', 'next2', 'next1', 'next2', 'next1'],
    'first 5 combined hits pass across both instances',
  );

  // 6th combined hit — whichever instance — is limited.
  const res1 = mockRes();

  await api1(reqFor('1.1.1.1'), res1, () => results.push('never1'));

  assert.equal(res1.statusCode, 429);
  assert.equal(res1.body.code, 'RATE_LIMITED');
  assert.equal(res1.body.message, 'limit reached');
  assert.equal(res1.headers['X-RateLimit-Remaining'], 0);

  const res2 = mockRes();

  await api2(reqFor('1.1.1.1'), res2, () => results.push('never2'));

  assert.equal(res2.statusCode, 429, 'API #2 also refuses — the budget is shared');
});

test('shared budget is identity-scoped: a different IP has its own budget', async () => {
  resetRateLimitStoreForTests();

  const store = createRateLimitStore({
    sharedName: 'login-test',

    windowMs: 60000,

    io: fakeRedisIo(),
  });

  const limiter = securityRateLimit({
    maximum: 2,

    windowMs: 60000,

    store,
  });

  const ok = mockRes();

  await limiter(reqFor('2.2.2.2'), ok, () => {});

  assert.equal(ok.statusCode, null);

  const fresh = mockRes();

  await limiter(reqFor('3.3.3.3'), fresh, () => {});

  assert.equal(fresh.statusCode, null, 'different identity = different bucket');
});

test('no cross-surface collisions: same identity, different sharedName → independent budgets', async () => {
  resetRateLimitStoreForTests();

  const login = createRateLimitStore({
    sharedName: 'login-test',

    windowMs: 60000,

    io: fakeRedisIo(),
  });

  const kiosk = createRateLimitStore({
    sharedName: 'kiosk-session',

    windowMs: 60000,

    io: fakeRedisIo(),
  });

  await login.hit('1.1.1.1:/x', 1);

  const kioskResult = await kiosk.hit('1.1.1.1:/x', 1);

  assert.equal(kioskResult.count, 1, 'surfaces never share counters');
});

test('key prefix is environment-scoped (crewly:<env>:rl:<name>:)', async () => {
  const store = createRateLimitStore({
    sharedName: 'login-test',

    windowMs: 60000,

    io: fakeRedisIo(),
  });

  assert.match(store.keyPrefix, /^crewly:[a-z]+:rl:login-test:$/);
});

// ═════════════════════════════════════════════════════════════
//  Degraded behavior — never worse than per-process
// ═════════════════════════════════════════════════════════════

test('Redis unavailable (null client) → falls back to in-process buckets, limit still enforced', async () => {
  resetRateLimitStoreForTests();

  const store = createRateLimitStore({
    sharedName: 'login-test',

    windowMs: 60000,

    io: {
      incr: async () => null, // disabled client

      get: async () => null,

      del: async () => {},
    },
  });

  const limiter = securityRateLimit({
    maximum: 2,

    windowMs: 60000,

    store,
  });

  const one = mockRes();

  await limiter(reqFor('4.4.4.4'), one, () => {});

  const two = mockRes();

  await limiter(reqFor('4.4.4.4'), two, () => {});

  const three = mockRes();

  await limiter(reqFor('4.4.4.4'), three, () => {});

  assert.equal(one.statusCode, null);
  assert.equal(two.statusCode, null);
  assert.equal(three.statusCode, 429, 'fallback still enforces the limit');
});

test('Redis ERRORS are absorbed: request served via fallback, circuit opens, no 500s', async () => {
  resetRateLimitStoreForTests();

  let failures = 0;

  const store = createRateLimitStore({
    sharedName: 'login-test',

    windowMs: 60000,

    io: {
      incr: async () => {
        failures += 1;

        throw new Error('connection refused');
      },

      get: async () => {
        throw new Error('connection refused');
      },

      del: async () => {},
    },
  });

  const limiter = securityRateLimit({
    maximum: 100,

    windowMs: 60000,

    store,
  });

  const res = mockRes();

  let nextCalled = false;

  await limiter(reqFor('5.5.5.5'), res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, 'Redis failure never breaks the request');
  assert.equal(res.statusCode, null);
  assert.ok(failures >= 1);

  // Circuit open: the second hit must NOT touch Redis again.
  failures = 0;

  const res2 = mockRes();

  await limiter(reqFor('5.5.5.5'), res2, () => {});

  assert.equal(failures, 0, 'circuit breaker skips Redis during cooldown');
  assert.equal(res2.statusCode, null);
});

// ═════════════════════════════════════════════════════════════
//  Window expiry
// ═════════════════════════════════════════════════════════════

test('fixed window expires: counter resets after the TTL', async () => {
  resetRateLimitStoreForTests();

  const io = fakeRedisIo();

  const store = createRateLimitStore({
    sharedName: 'window-test',

    windowMs: 30,

    io,
  });

  await store.hit('9.9.9.9', 5);

  const second = await store.hit('9.9.9.9', 5);

  assert.equal(second.count, 2);

  // Expire the window manually (TTL emulation).
  const key = [...io.store.keys()][0];

  io.store.get(key).expiresAt = Date.now() - 1;

  const fresh = await store.hit('9.9.9.9', 5);

  assert.equal(fresh.count, 1, 'new window starts at 1');
});

// ═════════════════════════════════════════════════════════════
//  Super Admin login guard — shared across instances
// ═════════════════════════════════════════════════════════════

test('super admin guard: 5 failures on instance A block instance B; clear() unblocks both', async () => {
  resetRateLimitStoreForTests();

  const store = createRateLimitStore({
    sharedName: 'super-admin-login',

    windowMs: 15 * 60 * 1000,

    io: fakeRedisIo(),
  });

  const instanceA = createSuperAdminLoginGuard({ store });

  const instanceB = createSuperAdminLoginGuard({ store });

  const req = {
    ip: '6.6.6.6',

    body: { email: 'admin@crewly.test' },
  };

  // Under the maximum → passes, attaches recording hooks.
  const pass = mockRes();

  let nextA = false;

  await instanceA(req, pass, () => {
    nextA = true;
  });

  assert.equal(nextA, true);
  assert.equal(typeof req.recordAdminLoginFailure, 'function');

  // 5 failures recorded "on instance A".
  for (let index = 0; index < 5; index += 1) {
    req.recordAdminLoginFailure();
  }

  await new Promise((resolve) => setTimeout(resolve, 10));

  // Instance B sees the shared block.
  const blocked = mockRes();

  let nextB = false;

  await instanceB(req, blocked, () => {
    nextB = true;
  });

  assert.equal(nextB, false);
  assert.equal(blocked.statusCode, 429);

  // clear (successful login) unblocks both.
  await req.clearAdminLoginAttempts();

  const recovered = mockRes();

  let nextC = false;

  await instanceB(req, recovered, () => {
    nextC = true;
  });

  assert.equal(nextC, true);
});

test('super admin guard: normal attempts never attach block state (contract unchanged)', async () => {
  resetRateLimitStoreForTests();

  const guard = createSuperAdminLoginGuard({
    store: createRateLimitStore({
      sharedName: 'super-admin-login',

      windowMs: 15 * 60 * 1000,

      io: fakeRedisIo(),
    }),
  });

  const res = mockRes();

  const req = {
    ip: '7.7.7.7',

    body: { email: 'Admin@Crewly.Test' }, // normalized in the key
  };

  await guard(req, res, () => {});

  assert.equal(res.statusCode, null);
  assert.equal(typeof req.recordAdminLoginFailure, 'function');
  assert.equal(typeof req.clearAdminLoginAttempts, 'function');
});

// ═════════════════════════════════════════════════════════════
//  Wiring pins — the security surfaces opted into the shared tier
// ═════════════════════════════════════════════════════════════

test('security-sensitive surfaces carry sharedName (multi-instance budget)', async () => {
  const surfaces = {
    'src/routes/authRoutes.js': 0, // uses exported shared limiters

    'src/routes/attendanceKioskRoutes.js': 3,

    'src/routes/attendanceRoutes.js': 1,

    'src/routes/bgvVerifierAuthRoutes.js': 2,

    'src/routes/bgvVerifierWorkRoutes.js': 1,

    'src/routes/publicCareerRoutes.js': 2,

    'src/routes/publicCandidateOfferRoutes.js': 2,

    'src/routes/publicBgvConsentRoutes.js': 2,

    'src/routes/publicBgvCollectionRoutes.js': 4,

    'src/routes/publicCandidatePreOnboardingRoutes.js': 2,
  };

  for (const [path, expected] of Object.entries(surfaces)) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');

    const count = (source.match(/sharedName: '/g) || []).length;

    assert.equal(
      count,
      expected,
      `${path} must wire ${expected} shared limiter(s)`,
    );
  }

  // The exported auth limiters themselves are shared.
  const limiterSource = await readFile(
    new URL('../src/middlewares/securityRateLimit.js', import.meta.url),
    'utf8',
  );

  for (const name of ["'login'", "'password-reset'", "'refresh'", "'password-change'"]) {
    assert.ok(
      limiterSource.includes(`sharedName: ${name}`),
      `exported limiter ${name} must be shared`,
    );
  }
});

test('safety pins: no KEYS/SCAN/FLUSH in the rate-limit path; local fallback is bounded', async () => {
  const source = await readFile(
    new URL('../src/utils/rateLimitStore.js', import.meta.url),
    'utf8',
  );

  // Redis KEYS/SCAN/FLUSH are banned — exact keys + TTL only. (The
  // bounded fallback's own Map `.keys()` eviction is fine and allowed.)
  const banned = [/client\.keys/i, /connection\.keys/i, /\.scan\(/i, /flushall/i, /flushdb/i];

  for (const pattern of banned) {
    assert.ok(
      !pattern.test(source),
      `rate-limit store must never use ${pattern}`,
    );
  }

  assert.match(source, /FALLBACK_MAX_KEYS = 10000/);
  assert.match(source, /CIRCUIT_COOLDOWN_MS = 30 \* 1000/);

  // Super Admin guard still exported under its contract name.
  const guardSource = await readFile(
    new URL('../src/middlewares/superAdminAuth.js', import.meta.url),
    'utf8',
  );

  assert.match(guardSource, /export const superAdminLoginGuard = createSuperAdminLoginGuard/);
});
