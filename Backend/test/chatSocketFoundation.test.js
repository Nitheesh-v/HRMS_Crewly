// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.1 — CHAT SOCKET FOUNDATION (hermetic)
//
//  No live Redis, no Mongo, no network, no open ports: every collaborator
//  is injected (the sanctioned pattern used by realtimeFoundation /
//  redisFoundation). Source-read pins guard the laws that cannot be
//  exercised without a real transport (attach order, io.close() ban,
//  TLS posture, non-goals, PLATFORM_ROLES drift).
//
//  Pinned here: token-source-only auth · every non-tenant principal
//  rejected · companyId derived from Mongo, never from a claim ·
//  FEATURE_UNAVAILABLE when Redis is absent · cookie:false · no wildcard
//  CORS · origin gate covers both transports · env-namespaced adapter key
//  · bounded drain that never closes the shared HTTP server · NO chat
//  product surface exists yet.
// ═══════════════════════════════════════════════════════════════════════════
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI =
  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chat-socket-foundation';

const {
  verifyChatSocketToken,
  createChatHandshakeAuth,
  SOCKET_AUTH_REASONS,
} = await import('../src/socket/socketAuth.js');

const {
  parseChatSocketEnabled,
  chatAdapterKey,
  chatAllowedOrigins,
  isChatOriginAllowed,
  CHAT_FEATURE_UNAVAILABLE,
  CHAT_UNAUTHORIZED,
  CHAT_SOCKET_PATH,
} = await import('../src/socket/socketConfig.js');
const { buildChatSocketOptions, createChatSocketServer } = await import(
  '../src/socket/initSocketServer.js'
);
const { createChatRedisAdapter } = await import('../src/socket/socketRedisAdapter.js');
const {
  createChatSocketAvailability,
  CHAT_REALTIME_STATES,
  CHAT_UNAVAILABLE_REASONS,
} = await import('../src/socket/socketAvailability.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');
const readSocket = (name) => read(`socket/${name}`);

/**
 * Drops comment lines so a source pin asserts on CODE, not on prose that
 * merely mentions a forbidden token.
 */
const stripComments = (source) =>
  source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();

      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');

// ── Fixtures ────────────────────────────────────────────────────────────────
const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A1 = 'cccccccccccccccccccccccc';
const SESSION_ID = 'session-0001';

const tenantClaims = (overrides = {}) => ({
  sub: USER_A1,
  companyId: COMPANY_A,
  sessionId: SESSION_ID,
  tokenVersion: 3,
  ...overrides,
});

const activeUser = (overrides = {}) => ({
  status: 'ACTIVE',
  role: 'HR_MANAGER',
  companyId: COMPANY_A,
  tokenVersion: 3,
  ...overrides,
});

/** Injected Mongo/JWT fakes — the real defaults are never reached here. */
const makeDeps = ({
  decoded = tenantClaims(),
  user = activeUser(),
  session = { sessionId: SESSION_ID },
  company = { status: 'ACTIVE' },
  onVerifyJwt = () => {},
} = {}) => ({
  verifyJwt: (value) => {
    onVerifyJwt(value);

    if (decoded instanceof Error) throw decoded;

    return decoded;
  },
  findUser: async () => user,
  findSession: async () => session,
  findCompany: async () => company,
  now: () => new Date('2026-09-22T00:00:00.000Z'),
});

const expiredError = () => {
  const error = new Error('jwt expired');

  error.name = 'TokenExpiredError';

  return error;
};

const malformedError = () => {
  const error = new Error('jwt malformed');

  error.name = 'JsonWebTokenError';

  return error;
};

const readyAvailability = () => {
  const availability = createChatSocketAvailability();

  availability.markReady();

  return availability;
};

const DEV_SOURCE = {
  NODE_ENV: 'development',
  CLIENT_URL: 'http://localhost:5173,https://crewly.example.com',
};

// A Socket.IO stand-in with exactly the surface this module touches.
const createFakeIo = () => {
  const calls = { adapter: [], use: [], on: [], disconnects: 0, engineClosed: 0, adapterClosed: 0 };

  return {
    calls,
    engine: {
      clientsCount: 0,
      close: () => {
        calls.engineClosed += 1;
      },
    },
    adapter: (value) => calls.adapter.push(value),
    use: (fn) => calls.use.push(fn),
    on: (event, fn) => calls.on.push({ event, fn }),
    of: () => ({
      adapter: {
        close: async () => {
          calls.adapterClosed += 1;
        },
      },
    }),
    disconnectSockets: () => {
      calls.disconnects += 1;
    },
    close: () => {
      throw new Error('io.close() must never be called — it closes the shared HTTP server');
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 config — explicit parsing and code-owned bounds', () => {
  test('CHAT_SOCKET_ENABLED uses an explicit parser, never Boolean(env)', () => {
    assert.equal(parseChatSocketEnabled({ CHAT_SOCKET_ENABLED: 'true' }), true);
    assert.equal(parseChatSocketEnabled({ CHAT_SOCKET_ENABLED: 'TRUE' }), true);
    assert.equal(parseChatSocketEnabled({ CHAT_SOCKET_ENABLED: ' true ' }), true);
    assert.equal(parseChatSocketEnabled({ CHAT_SOCKET_ENABLED: 'false' }), false);
    assert.equal(parseChatSocketEnabled({ CHAT_SOCKET_ENABLED: '1' }), false);
    assert.equal(parseChatSocketEnabled({ CHAT_SOCKET_ENABLED: 'yes' }), false);
    assert.equal(parseChatSocketEnabled({}), false);
    assert.equal(parseChatSocketEnabled({ CHAT_SOCKET_ENABLED: '' }), false);
  });

  test('the error contracts are frozen, stable and secret-free', () => {
    assert.equal(CHAT_FEATURE_UNAVAILABLE.code, 'FEATURE_UNAVAILABLE');
    assert.equal(CHAT_UNAUTHORIZED.code, 'UNAUTHORIZED');
    assert.ok(Object.isFrozen(CHAT_FEATURE_UNAVAILABLE));
    assert.ok(Object.isFrozen(CHAT_UNAUTHORIZED));

    for (const contract of [CHAT_FEATURE_UNAVAILABLE, CHAT_UNAUTHORIZED]) {
      assert.doesNotMatch(contract.message, /redis|redis:\/|token|secret|jwt|mongodb/i);
    }
  });

  test('the adapter key is env-namespaced and separate from the SSE namespace', () => {
    assert.equal(chatAdapterKey('crewly:production'), 'crewly:production:chat:adapter');
    assert.equal(chatAdapterKey('crewly:staging'), 'crewly:staging:chat:adapter');
    assert.notEqual(chatAdapterKey('crewly:production'), chatAdapterKey('crewly:staging'));
    assert.ok(!chatAdapterKey('crewly:development').includes(':realtime:'));
  });

  test('the socket path is the code-owned default', () => {
    assert.equal(CHAT_SOCKET_PATH, '/socket.io');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 origin gate — never a wildcard', () => {
  test('allows exactly the CLIENT_URL allowlist entries', () => {
    assert.equal(isChatOriginAllowed('http://localhost:5173', DEV_SOURCE), true);
    assert.equal(isChatOriginAllowed('https://crewly.example.com', DEV_SOURCE), true);
    assert.equal(isChatOriginAllowed('https://crewly.example.com/', DEV_SOURCE), true);
  });

  test('refuses any origin outside the allowlist', () => {
    assert.equal(isChatOriginAllowed('https://evil.example', DEV_SOURCE), false);
    assert.equal(isChatOriginAllowed('http://localhost:5174', DEV_SOURCE), false);
    assert.equal(isChatOriginAllowed('null', DEV_SOURCE), false);
    assert.equal(isChatOriginAllowed('*', DEV_SOURCE), false);
  });

  test('refuses a MISSING origin — stricter than app.js (fail closed)', () => {
    assert.equal(isChatOriginAllowed(undefined, DEV_SOURCE), false);
    assert.equal(isChatOriginAllowed('', DEV_SOURCE), false);
    assert.equal(isChatOriginAllowed(null, DEV_SOURCE), false);
  });

  test('the dev-only preview allowance never applies in production', () => {
    const preview = 'https://5173-abc123.e2b.app';
    const production = { NODE_ENV: 'production', CLIENT_URL: 'https://crewly.example.com' };

    assert.equal(isChatOriginAllowed(preview, DEV_SOURCE), true);
    assert.equal(isChatOriginAllowed(preview, production), false);
  });

  test('an empty CLIENT_URL allows nothing at all', () => {
    assert.deepEqual(chatAllowedOrigins({ CLIENT_URL: '' }), []);
    assert.equal(isChatOriginAllowed('http://localhost:5173', { CLIENT_URL: '' }), false);
  });

  test('localhost opt-in flag (33.8): off by default, on only for literal true', () => {
    const locked = { NODE_ENV: 'production', CLIENT_URL: 'https://crewly.example.com' };
    const optedIn = { ...locked, CHAT_ALLOW_LOCALHOST_ORIGINS: 'true' };

    // Default stays strict: loopback and missing origin refused.
    assert.equal(isChatOriginAllowed('http://localhost:5173', locked), false);
    assert.equal(isChatOriginAllowed(undefined, locked), false);

    // Opted in: loopback on any port, and the absent-Origin proxy edge.
    assert.equal(isChatOriginAllowed('http://localhost:5173', optedIn), true);
    assert.equal(isChatOriginAllowed('http://127.0.0.1:5173', optedIn), true);
    assert.equal(isChatOriginAllowed(undefined, optedIn), true);

    // Never widens to non-loopback origins.
    assert.equal(isChatOriginAllowed('https://evil.example', optedIn), false);

    // Parsed like every enablement flag: only the literal 'true'.
    assert.equal(
      isChatOriginAllowed('http://localhost:5173', { ...locked, CHAT_ALLOW_LOCALHOST_ORIGINS: 'yes' }),
      false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 handshake auth — token source (a)', () => {
  test('rejects a missing token', async () => {
    for (const token of [undefined, null, '', '   ', 42, {}, []]) {
      const result = await verifyChatSocketToken(token, makeDeps());

      assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(token)}`);
      assert.equal(result.reason, SOCKET_AUTH_REASONS.MISSING_TOKEN);
    }
  });

  test('rejects a malformed token (b)', async () => {
    const result = await verifyChatSocketToken('not.a.jwt', makeDeps({ decoded: malformedError() }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.MALFORMED_TOKEN);
  });

  test('rejects an expired token', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps({ decoded: expiredError() }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.EXPIRED_TOKEN);
  });

  test('rejects an unexpected verifier failure without leaking it', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps({ decoded: new Error('boom') }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.INVALID_TOKEN);
  });

  test('rejects a token that decodes to a non-object', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps({ decoded: null }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.INVALID_TOKEN);
  });

  test('reads the token from the auth payload only — never query, header or body', () => {
    const source = readSocket('socketAuth.js');

    assert.match(source, /socket\?\.handshake\?\.auth\?\.token/);
    assert.ok(!source.includes('handshake.query'));
    assert.ok(!source.includes('handshake.headers'));
    assert.ok(!source.includes('req.cookies'));
    assert.ok(!source.includes('socket.request.headers.cookie'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 handshake auth — principal rejection (c, repo truth)', () => {
  test('rejects the BGV verifier principal (30.6)', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({ decoded: { verifierId: 'v1', sessionId: 's', principalType: 'BGV_VERIFIER' } }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.WRONG_PORTAL);
  });

  test('rejects the kiosk device token (typ:"kiosk")', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({ decoded: { typ: 'kiosk', stationId: 'st1', companyId: COMPANY_A, sv: 1 } }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.WRONG_PORTAL);
  });

  test('rejects the kiosk employee-context token (typ:"kiosk-employee")', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({
        decoded: {
          typ: 'kiosk-employee',
          companyId: COMPANY_A,
          stationId: 'st1',
          userId: USER_A1,
          pv: 0,
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.WRONG_PORTAL);
  });

  test('rejects a subject-less token (kiosk/candidate shapes carry no sub)', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps({ decoded: { companyId: COMPANY_A } }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.INVALID_SUBJECT);
  });

  test('rejects every platform role — platform auth is AdminSession, not a tenant JWT', async () => {
    for (const role of ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_ADMIN', 'BILLING_ADMIN']) {
      const result = await verifyChatSocketToken(
        'a.b.c',
        makeDeps({
          decoded: { id: USER_A1, role, companyId: null, sessionId: SESSION_ID },
          user: activeUser({ role, companyId: null }),
        }),
      );

      assert.equal(result.ok, false, `${role} must be refused`);
      assert.equal(result.reason, SOCKET_AUTH_REASONS.WRONG_PORTAL);
    }
  });

  test('candidate portals hold no JWT at all — secure tokens ride the URL, never a socket', () => {
    // Repo truth: public candidate surfaces are slug/secureToken scoped
    // (publicCandidateOfferRoutes / publicCandidatePreOnboardingRoutes /
    // publicBgvConsentRoutes) and never mint a tenant JWT, so there is no
    // candidate token shape this handshake could accept.
    const routes = read('routes/index.js');

    assert.match(routes, /public\/candidate\/offers/);
    assert.match(routes, /public\/candidate\/pre-onboarding/);
  });

  test('PLATFORM_ROLES here mirrors src/middlewares/authMiddleware.js exactly', () => {
    const socketSource = readSocket('socketAuth.js');
    const httpSource = read('middlewares/authMiddleware.js');

    const roles = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_ADMIN', 'BILLING_ADMIN'];

    for (const role of roles) {
      assert.ok(socketSource.includes(`'${role}'`), `socketAuth is missing ${role}`);
      assert.ok(httpSource.includes(`'${role}'`), `authMiddleware is missing ${role}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 handshake auth — tenant authority is server-derived', () => {
  test('accepts a valid tenant token and derives companyId from MONGO', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps());

    assert.deepEqual(result, {
      ok: true,
      userId: USER_A1,
      companyId: COMPANY_A,
      sessionId: SESSION_ID,
    });
  });

  test('a token claiming a DIFFERENT company than the Mongo user is refused', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({ decoded: tenantClaims({ companyId: COMPANY_B }) }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.TENANT_MISMATCH);
  });

  test('companyId always comes from the user document, never the claim', async () => {
    let sessionFilter = null;

    const result = await verifyChatSocketToken('a.b.c', {
      ...makeDeps(),
      findSession: async (filter) => {
        sessionFilter = filter;

        return { sessionId: SESSION_ID };
      },
    });

    assert.equal(result.companyId, COMPANY_A);
    // The claim is only ever used as a session-scoping filter value.
    assert.equal(sessionFilter.companyId, COMPANY_A);
  });

  test('rejects a legacy token with no sessionId', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({ decoded: { sub: USER_A1, companyId: COMPANY_A, role: 'EMPLOYEE' } }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.LEGACY_TOKEN);
  });

  test('rejects a legacy token with no tokenVersion', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({ decoded: { sub: USER_A1, companyId: COMPANY_A, sessionId: SESSION_ID } }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.LEGACY_TOKEN);
  });

  test('rejects a tokenVersion mismatch (forced logout)', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({ decoded: tenantClaims({ tokenVersion: 2 }) }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.LEGACY_TOKEN);
  });

  test('rejects a missing account', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps({ user: null }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.ACCOUNT_MISSING);
  });

  test('rejects a deactivated account', async () => {
    const result = await verifyChatSocketToken(
      'a.b.c',
      makeDeps({ user: activeUser({ status: 'INACTIVE' }) }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.ACCOUNT_INACTIVE);
  });

  test('rejects a revoked or expired session', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps({ session: null }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.SESSION_INVALID);
  });

  test('the session lookup is scoped by sessionId + user + company + not-revoked + not-expired', async () => {
    let filter = null;

    await verifyChatSocketToken('a.b.c', {
      ...makeDeps(),
      findSession: async (value) => {
        filter = value;

        return { sessionId: SESSION_ID };
      },
    });

    assert.equal(filter.sessionId, SESSION_ID);
    assert.equal(filter.user, USER_A1);
    assert.equal(filter.revokedAt, null);
    assert.ok(filter.expiresAt.$gt instanceof Date);
  });

  test('refuses a suspended / deactivated / archived company (tenantContext parity)', async () => {
    for (const status of ['SUSPENDED', 'DEACTIVATED', 'ARCHIVED']) {
      const result = await verifyChatSocketToken('a.b.c', makeDeps({ company: { status } }));

      assert.equal(result.ok, false, `${status} must be refused`);
      assert.equal(result.reason, SOCKET_AUTH_REASONS.COMPANY_UNAVAILABLE);
    }
  });

  test('refuses a tenant whose company document is gone', async () => {
    const result = await verifyChatSocketToken('a.b.c', makeDeps({ company: null }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, SOCKET_AUTH_REASONS.NO_TENANT);
  });

  test('the user read is a bounded select, never the whole document', () => {
    assert.match(
      readSocket('socketAuth.js'),
      /select\('status role companyId tokenVersion'\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 handshake middleware', () => {
  const fakeSocket = (token) => ({ handshake: { auth: { token } }, data: {} });

  test('sets only server-derived identity on socket.data', async () => {
    const socket = fakeSocket('a.b.c');
    let nextError = 'not-called';

    await createChatHandshakeAuth({
      availability: readyAvailability(),
      verify: async () => ({ ok: true, userId: USER_A1, companyId: COMPANY_A, sessionId: SESSION_ID }),
      unauthorized: CHAT_UNAUTHORIZED,
    })(socket, (error) => {
      nextError = error;
    });

    assert.equal(nextError, undefined);
    assert.deepEqual(socket.data, {
      userId: USER_A1,
      companyId: COMPANY_A,
      sessionId: SESSION_ID,
    });
  });

  test('a client-supplied companyId in the auth payload is never read', async () => {
    const socket = {
      handshake: { auth: { token: 'a.b.c', companyId: COMPANY_B, userId: 'deadbeef' } },
      data: {},
    };

    await createChatHandshakeAuth({
      availability: readyAvailability(),
      verify: async () => ({ ok: true, userId: USER_A1, companyId: COMPANY_A, sessionId: SESSION_ID }),
      unauthorized: CHAT_UNAUTHORIZED,
    })(socket, () => {});

    assert.equal(socket.data.companyId, COMPANY_A);
    assert.notEqual(socket.data.companyId, COMPANY_B);
  });

  test('auth failure yields the ONE generic contract — no reason leakage', async () => {
    const seen = [];

    await createChatHandshakeAuth({
      availability: readyAvailability(),
      verify: async () => ({ ok: false, reason: SOCKET_AUTH_REASONS.TENANT_MISMATCH }),
      unauthorized: CHAT_UNAUTHORIZED,
      onRefusal: (reason) => seen.push(reason),
    })(fakeSocket('a.b.c'), () => {});

    assert.deepEqual(seen, [SOCKET_AUTH_REASONS.TENANT_MISMATCH]);
  });

  test('FEATURE_UNAVAILABLE is decided BEFORE any token work (no Mongo spend)', async () => {
    let verifyCalled = false;
    const availability = createChatSocketAvailability();

    availability.markUnavailable('REDIS_DISABLED');

    let error = null;

    await createChatHandshakeAuth({
      availability,
      verify: async () => {
        verifyCalled = true;

        return { ok: true };
      },
      unauthorized: CHAT_UNAUTHORIZED,
    })(fakeSocket('a.b.c'), (value) => {
      error = value;
    });

    assert.equal(verifyCalled, false);
    assert.equal(error.data.code, 'FEATURE_UNAVAILABLE');
    assert.equal(error.data.message, CHAT_FEATURE_UNAVAILABLE.message);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 FEATURE_UNAVAILABLE gate (d)', () => {
  test('REDIS_ENABLED=false ⇒ adapter refused and NO client is created', async () => {
    let created = 0;

    const result = await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'false', REDIS_URL: 'redis://127.0.0.1:6379' },
      createRedisClient: () => {
        created += 1;

        return {};
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.deepEqual(result, { ok: false, reason: 'REDIS_DISABLED' });
    assert.equal(created, 0);
  });

  test('an invalid REDIS_ENABLED value degrades to disabled (28.1 parser reuse)', async () => {
    const result = await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'maybe', REDIS_URL: 'redis://127.0.0.1:6379' },
      createRedisClient: () => ({}),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REDIS_DISABLED');
  });

  test('REDIS_ENABLED=true with an empty REDIS_URL ⇒ REDIS_MISCONFIGURED', async () => {
    const result = await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'true', REDIS_URL: '   ' },
      createRedisClient: () => ({}),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REDIS_MISCONFIGURED');
  });

  test('a connect failure is classified without leaking the URL', async () => {
    const logs = [];

    const result = await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://user:pass@127.0.0.1:6399' },
      createRedisClient: () => ({
        on: () => {},
        duplicate() {
          return this;
        },
        connect: async () => {
          throw new Error('connect ECONNREFUSED redis://user:pass@127.0.0.1:6399');
        },
        quit: async () => {},
      }),
      log: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REDIS_ERROR');

    for (const line of logs) {
      assert.ok(!line.includes('pass'), 'a credential must never reach a log');
      assert.ok(!line.includes('redis://'), 'a connection URL must never reach a log');
    }
  });

  test('a slow connect times out as REDIS_CONNECT_TIMEOUT', async () => {
    const result = await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6379' },
      readyTimeoutMs: 20,
      createRedisClient: () => ({
        on: () => {},
        duplicate() {
          return this;
        },
        connect: () => new Promise(() => {}),
        quit: async () => {},
      }),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REDIS_CONNECT_TIMEOUT');
  });

  test('every reason is from the safe published vocabulary', () => {
    for (const reason of [
      'REDIS_DISABLED',
      'REDIS_MISCONFIGURED',
      'REDIS_CONNECT_TIMEOUT',
      'REDIS_ERROR',
    ]) {
      assert.ok(CHAT_UNAVAILABLE_REASONS.includes(reason), `${reason} must be published`);
    }
  });

  test('availability refusal is ONE stable shape and never leaks the reason', () => {
    const availability = createChatSocketAvailability();

    assert.deepEqual(availability.getState(), { state: 'DISABLED', reason: null });
    assert.equal(availability.refusal().code, 'FEATURE_UNAVAILABLE');
    assert.equal(availability.refusal().message, CHAT_FEATURE_UNAVAILABLE.message);
    assert.equal(availability.refusal().reason, undefined);

    availability.markUnavailable('REDIS_ERROR');
    assert.equal(availability.getState().reason, 'REDIS_ERROR');
    assert.equal(availability.refusal().code, 'FEATURE_UNAVAILABLE');
    assert.equal(availability.refusal().reason, undefined);

    availability.markStopped();
    assert.equal(availability.refusal().code, 'FEATURE_UNAVAILABLE');

    availability.markReady();
    assert.equal(availability.refusal(), null);
    assert.equal(availability.isReady(), true);
  });

  test('an unknown reason is normalised, never echoed', () => {
    const availability = createChatSocketAvailability();

    availability.markUnavailable('mongodb://user:pass@host/db');

    assert.equal(availability.getState().reason, 'ADAPTER_FAILURE');
  });

  test('attach() with the feature disabled creates NO server and NO adapter', async () => {
    let adapterCalls = 0;
    let serverCalls = 0;

    const chat = createChatSocketServer({
      enabled: false,
      createAdapterClients: async () => {
        adapterCalls += 1;

        return { ok: false, reason: 'REDIS_DISABLED' };
      },
      createServer: () => {
        serverCalls += 1;

        return createFakeIo();
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await chat.attach({});

    assert.deepEqual(result, { started: false, reason: 'DISABLED' });
    assert.equal(adapterCalls, 0);
    assert.equal(serverCalls, 0);
    assert.equal(chat.getAvailability().getState().state, CHAT_REALTIME_STATES.DISABLED);
  });

  test('attach() with Redis unavailable reports FEATURE_UNAVAILABLE and admits nothing', async () => {
    const io = createFakeIo();

    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async () => ({ ok: false, reason: 'REDIS_DISABLED' }),
      createServer: () => io,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await chat.attach({});

    assert.equal(result.started, false);
    assert.equal(result.reason, 'FEATURE_UNAVAILABLE');
    assert.equal(chat.getAvailability().getState().state, CHAT_REALTIME_STATES.UNAVAILABLE);
    assert.equal(chat.getAvailability().getState().reason, 'REDIS_DISABLED');

    // The Server IS created so Engine.IO owns the /socket.io path and
    // answers with the stable refusal instead of an Express 404 — but no
    // adapter is attached and no connection can ever be admitted.
    assert.equal(io.calls.adapter.length, 0);
    assert.equal(chat.getAvailability().refusal().code, 'FEATURE_UNAVAILABLE');
  });

  test('a recovery signal can never re-open the gate without an attached adapter', async () => {
    let handlers = {};

    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async ({ onUp }) => {
        handlers = { onUp };

        return { ok: false, reason: 'REDIS_ERROR' };
      },
      createServer: () => createFakeIo(),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await chat.attach({});

    handlers.onUp();

    assert.equal(chat.getAvailability().isReady(), false);
    assert.equal(chat.getAvailability().refusal().code, 'FEATURE_UNAVAILABLE');
  });

  test('attach() without an HTTP server refuses safely', async () => {
    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async () => ({ ok: true, key: 'k', adapter: () => {}, close: async () => {} }),
      createServer: () => createFakeIo(),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await chat.attach(null);

    assert.equal(result.started, false);
    assert.equal(result.reason, 'FEATURE_UNAVAILABLE');
  });

  test('a runtime Redis loss flips to UNAVAILABLE and a recovery flips back', async () => {
    let handlers = {};

    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async ({ onDown, onUp }) => {
        handlers = { onDown, onUp };

        return { ok: true, key: 'crewly:test:chat:adapter', adapter: () => {}, close: async () => {} };
      },
      createServer: () => createFakeIo(),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await chat.attach({});

    assert.equal(chat.getAvailability().isReady(), true);

    handlers.onDown();
    assert.equal(chat.getAvailability().isReady(), false);
    assert.equal(chat.getAvailability().refusal().code, 'FEATURE_UNAVAILABLE');

    handlers.onUp();
    assert.equal(chat.getAvailability().isReady(), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 socket server options — security posture (e, f)', () => {
  const options = buildChatSocketOptions({
    availability: readyAvailability(),
    source: DEV_SOURCE,
  });

  test('cookies are disabled (e)', () => {
    assert.equal(options.cookie, false);
  });

  test('CORS is an explicit allowlist, never a wildcard (f)', () => {
    assert.deepEqual(options.cors.origin, [
      'http://localhost:5173',
      'https://crewly.example.com',
    ]);
    assert.ok(!options.cors.origin.includes('*'));
    assert.equal(options.cors.credentials, false);
    assert.ok(Array.isArray(options.cors.origin));
  });

  test('the bundled browser client is not served and EIO3 is refused', () => {
    assert.equal(options.serveClient, false);
    assert.equal(options.allowEIO3, false);
  });

  test('inbound frames are hard-capped well under the Engine.IO default', () => {
    assert.equal(options.maxHttpBufferSize, 16 * 1024);
    assert.ok(options.maxHttpBufferSize < 1024 * 1024);
  });

  test('both transports are enabled so a non-upgrading proxy still works', () => {
    assert.deepEqual(options.transports, ['websocket', 'polling']);
  });

  test('allowRequest refuses while the feature is not READY', () => {
    const availability = createChatSocketAvailability();

    availability.markUnavailable('REDIS_DISABLED');

    const gated = buildChatSocketOptions({ availability, source: DEV_SOURCE });
    const calls = [];

    gated.allowRequest({ headers: { origin: 'http://localhost:5173' } }, (message, ok) =>
      calls.push({ message, ok }),
    );

    assert.deepEqual(calls, [{ message: 'FEATURE_UNAVAILABLE', ok: false }]);
  });

  test('allowRequest refuses a disallowed origin with 403 semantics', () => {
    const calls = [];

    options.allowRequest({ headers: { origin: 'https://evil.example' } }, (message, ok) =>
      calls.push({ message, ok }),
    );

    assert.deepEqual(calls, [{ message: 'ORIGIN_NOT_ALLOWED', ok: false }]);
  });

  test('allowRequest refuses a missing origin', () => {
    const calls = [];

    options.allowRequest({ headers: {} }, (message, ok) => calls.push({ message, ok }));

    assert.deepEqual(calls, [{ message: 'ORIGIN_NOT_ALLOWED', ok: false }]);
  });

  test('allowRequest admits an allowlisted origin', () => {
    const calls = [];

    options.allowRequest({ headers: { origin: 'https://crewly.example.com' } }, (message, ok) =>
      calls.push({ message, ok }),
    );

    assert.deepEqual(calls, [{ message: null, ok: true }]);
  });

  test('no socket module ever disables TLS verification', () => {
    for (const file of [
      'socketConfig.js',
      'socketAuth.js',
      'socketAvailability.js',
      'socketRedisAdapter.js',
      'initSocketServer.js',
    ]) {
      const code = stripComments(readSocket(file));

      // An actual assignment is the only thing that could weaken TLS.
      assert.ok(
        !/rejectUnauthorized\s*:/.test(code),
        `${file} must never set rejectUnauthorized`,
      );
      assert.ok(!code.includes('tls: false'), `${file} must never disable TLS`);
    }
  });

  test('rediss:// is documented as the TLS path and is never rewritten', () => {
    assert.match(readSocket('socketRedisAdapter.js'), /rediss:/);
    assert.ok(!readSocket('socketRedisAdapter.js').includes('tls: false'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 redis adapter design', () => {
  const recordingClient = () => {
    const client = {
      events: {},
      connected: 0,
      quitCalls: 0,
      on(event, handler) {
        client.events[event] = handler;

        return client;
      },
      duplicate: () => subClient,
      connect: async () => {
        client.connected += 1;
      },
      quit: async () => {
        client.quitCalls += 1;
      },
    };

    return client;
  };

  let subClient = null;

  test('pub + sub are dedicated connections (sub via duplicate) with an env-namespaced key', async () => {
    const pub = recordingClient();

    subClient = recordingClient();

    const seen = {};

    const result = await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6379' },
      createRedisClient: () => pub,
      adapterFactory: (pubClient, subClientArg, opts) => {
        seen.pubClient = pubClient;
        seen.subClient = subClientArg;
        seen.opts = opts;

        return () => {};
      },
      key: 'crewly:test:chat:adapter',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(result.ok, true);
    assert.equal(result.key, 'crewly:test:chat:adapter');
    assert.deepEqual(seen.opts, { key: 'crewly:test:chat:adapter' });
    assert.equal(seen.pubClient, pub);
    assert.equal(seen.subClient, subClient);
    assert.notEqual(seen.pubClient, seen.subClient);
    assert.equal(pub.connected, 1);
    assert.equal(subClient.connected, 1);
  });

  test('both connections get an error handler so an emitter error cannot crash the API', async () => {
    const pub = recordingClient();

    subClient = recordingClient();

    await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6379' },
      createRedisClient: () => pub,
      adapterFactory: () => () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(typeof pub.events.error, 'function');
    assert.equal(typeof pub.events.ready, 'function');
    assert.equal(typeof subClient.events.error, 'function');
  });

  test('one error logs once per outage spell; ready resets it', async () => {
    const pub = recordingClient();
    const warnings = [];

    subClient = recordingClient();

    await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6379' },
      createRedisClient: () => pub,
      adapterFactory: () => () => {},
      log: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    });

    pub.events.error({ code: 'ECONNREFUSED' });
    pub.events.error({ code: 'ECONNREFUSED' });
    pub.events.error({ code: 'ECONNREFUSED' });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ECONNREFUSED/);

    pub.events.ready();
    pub.events.error({ code: 'ECONNREFUSED' });

    assert.equal(warnings.length, 2);
  });

  test('close() quits both connections and survives a closed client', async () => {
    const pub = recordingClient();

    subClient = {
      ...recordingClient(),
      quit: async () => {
        throw new Error('not connected');
      },
      destroy: async () => {
        throw new Error('ClientClosedError');
      },
    };

    const result = await createChatRedisAdapter({
      source: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6379' },
      createRedisClient: () => pub,
      adapterFactory: () => () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await result.close();

    assert.equal(pub.quitCalls, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 lifecycle', () => {
  test('attach() wires the adapter, the handshake guard and connection logging', async () => {
    const io = createFakeIo();

    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async () => ({
        ok: true,
        key: 'crewly:test:chat:adapter',
        adapter: () => {},
        close: async () => {},
      }),
      createServer: () => io,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await chat.attach({});

    assert.equal(result.started, true);
    assert.equal(result.path, '/socket.io');
    assert.equal(io.calls.adapter.length, 1);
    assert.equal(io.calls.use.length, 1);
    assert.deepEqual(
      io.calls.on.map((entry) => entry.event),
      ['connection'],
    );
    assert.equal(chat.getAvailability().getState().state, CHAT_REALTIME_STATES.READY);
  });

  test('an adapter that cannot be attached degrades instead of crashing the API', async () => {
    const io = createFakeIo();
    let closed = 0;

    io.adapter = () => {
      throw new TypeError('this.server.adapter(...) is not a constructor');
    };

    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async () => ({
        ok: true,
        key: 'k',
        adapter: () => {},
        close: async () => {
          closed += 1;
        },
      }),
      createServer: () => io,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await chat.attach({});

    assert.equal(result.started, false);
    assert.equal(result.reason, 'FEATURE_UNAVAILABLE');
    assert.equal(chat.getAvailability().getState().reason, 'ADAPTER_FAILURE');
    assert.equal(closed, 1);
  });

  test('a connection is counted and logged with metadata only', async () => {
    const io = createFakeIo();
    const logs = [];

    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async () => ({ ok: true, key: 'k', adapter: () => {}, close: async () => {} }),
      createServer: () => io,
      log: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
    });

    await chat.attach({});

    const connectionHandler = io.calls.on.find((entry) => entry.event === 'connection').fn;
    const socketEvents = [];
    const joinedRooms = [];
    const socket = {
      id: 'sock-1',
      data: { companyId: COMPANY_A, userId: USER_A1 },
      on: (event, fn) => socketEvents.push({ event, fn }),
      // Real Socket.IO sockets always expose join/leave; 33.8-fix joins the
      // member's personal room at connect time.
      join: (room) => joinedRooms.push(room),
      leave: () => {},
    };

    connectionHandler(socket);

    assert.equal(chat.describeDiagnostics().counters.connections_accepted, 1);
    assert.match(logs.at(-1), /company=aaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.ok(!logs.at(-1).includes('Bearer'));
    // 33.5/33.6 register the chat product events on top of the 33.1
    // lifecycle handlers; the connection must still never register anything
    // else (no typing/presence/read-marker events).
    assert.deepEqual(
      socketEvents.map((entry) => entry.event).sort(),
      [
        'chat:join',
        'chat:leave',
        'chat:message:delete',
        'chat:message:edit',
        'chat:message:send',
        'chat:readUpTo',
        'disconnect',
        'error',
      ],
    );

    // 33.8-fix: the member's personal room is joined at connect time so
    // list-change nudges can reach windows that have no conversation open.
    assert.deepEqual(joinedRooms, [`chat:user:${String(USER_A1)}`]);
  });

  test('stop() disconnects sockets, closes the engine and adapter, and NEVER calls io.close()', async () => {
    const io = createFakeIo();
    let adapterClosed = 0;

    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async () => ({
        ok: true,
        key: 'k',
        adapter: () => {},
        close: async () => {
          adapterClosed += 1;
        },
      }),
      createServer: () => io,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await chat.attach({});
    await chat.stop();

    assert.equal(io.calls.disconnects, 1);
    assert.equal(io.calls.engineClosed, 1);
    assert.equal(io.calls.adapterClosed, 1);
    assert.equal(adapterClosed, 1);
    assert.equal(chat.getAvailability().getState().state, CHAT_REALTIME_STATES.STOPPED);
    assert.equal(chat.getIo(), null);
  });

  test('stop() is idempotent and safe when never attached', async () => {
    const chat = createChatSocketServer({
      enabled: false,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await chat.stop();
    await chat.stop();

    assert.equal(chat.describeDiagnostics().localConnections, 0);
  });

  test('diagnostics expose counts and state only — no message content, no tokens', async () => {
    const chat = createChatSocketServer({
      enabled: true,
      createAdapterClients: async () => ({ ok: true, key: 'k', adapter: () => {}, close: async () => {} }),
      createServer: () => createFakeIo(),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await chat.attach({});

    const diagnostics = chat.describeDiagnostics();
    const serialized = JSON.stringify(diagnostics);

    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.state, 'READY');
    assert.ok(!serialized.includes('message'));
    assert.ok(!serialized.includes('token'));
    assert.ok(!serialized.includes('REDIS_URL'));
  });

  test('no product event is ever registered on a socket (33.1 non-goal)', () => {
    const source = readSocket('initSocketServer.js');

    for (const forbidden of [
      'chat:join',
      'chat:message',
      'chat:readUpTo',
      'typing',
      'presence',
      'lastSeen',
    ]) {
      assert.ok(!source.includes(`'${forbidden}'`), `${forbidden} must not exist in 33.1`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1 server wiring (source pins)', () => {
  const serverSource = read('server.js');

  test('the HTTP server is created explicitly and Socket.IO attaches BEFORE listen', () => {
    assert.match(serverSource, /import http from 'node:http';/);
    assert.match(serverSource, /const server = http\.createServer\(app\);/);

    const attachAt = serverSource.indexOf('getChatSocketServer().attach(server)');
    const listenAt = serverSource.indexOf('server.listen(');

    assert.ok(attachAt > 0, 'chat socket must be attached in server.js');
    assert.ok(listenAt > 0, 'the server must be started with server.listen');
    assert.ok(attachAt < listenAt, 'attach MUST run before listen (Engine.IO ws init law)');
    assert.ok(!serverSource.includes('app.listen('), 'app.listen must be replaced');
  });

  test('the chat socket is drained on the same SIGTERM/SIGINT path as 32.11', () => {
    const drainAt = serverSource.indexOf('shutdownWithRealtime');

    assert.ok(drainAt > 0);
    assert.match(serverSource, /getChatSocketServer\(\)\.stop\(\)/);

    const chatStopAt = serverSource.indexOf('getChatSocketServer().stop()');
    const shutdownAt = serverSource.indexOf('.finally(() => shutdown(signal))');

    assert.ok(chatStopAt < shutdownAt, 'sockets must drain before the bounded 32.2 shutdown');
  });

  test('stop() never calls io.close(), which would close the shared HTTP server', () => {
    const code = stripComments(readSocket('initSocketServer.js'));

    assert.ok(!code.includes('io.close('), 'io.close() closes the shared HTTP server');
    assert.match(readSocket('initSocketServer.js'), /NEVER calls io\.close\(\)/);
  });

  test('Phase-32 health, drain and cache-policy behaviour is untouched', () => {
    assert.match(serverSource, /markReady\(\)/);
    assert.match(serverSource, /beginDrain\(/);

    const appSource = read('app.js');

    assert.match(appSource, /apiCachePolicyMiddleware/);
    assert.match(appSource, /applyProxyTrust\(app\)/);
    assert.match(appSource, /isDraining\(\)/);
  });

  test('the SSE realtime foundation is intact (locked decision: SSE stays as-is)', () => {
    const realtimeSource = read('infrastructure/realtime/realtimeGateway.js');

    assert.match(realtimeSource, /createRealtimeGateway/);
    assert.match(serverSource, /getRealtimeGateway\(\)\.start\(\)/);
    assert.ok(fs.existsSync(path.join(here, '..', 'src', 'routes', 'realtimeRoutes.js')));
    assert.ok(
      fs.existsSync(
        path.join(here, '..', 'src', 'infrastructure', 'realtime', 'realtimeConfig.js'),
      ),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('33.1/33.2 boundary — models exist, no chat product surface does', () => {
  const modelsDir = path.join(here, '..', 'src', 'models');
  const models = fs.readdirSync(modelsDir);

  // 33.2 landed the persistence layer, so the 33.1 "no chat model" pin is
  // deliberately inverted here rather than deleted: the models must exist
  // now, and everything else in this block must still not.
  test('the chat models exist (33.2) and are the only chat files in src/models', () => {
    const chatModels = models.filter((name) => /^Chat/i.test(name)).sort();

    assert.deepEqual(chatModels, [
      'ChatConversation.js',
      'ChatMessage.js',
      'ChatMessageEdit.js',
    ]);
  });

  test('the 33.1 foundation modules stay model-free (chat modules may import)', () => {
    // The five foundation modules must not import chat models directly —
    // product coupling belongs in the 33.5 chat modules, which are allowed to
    // import models/services. This keeps the handshake/adapter/availability
    // layer independent of the chat schema.
    const socketDir = path.join(here, '..', 'src', 'socket');
    const foundation = [
      'initSocketServer.js',
      'socketAuth.js',
      'socketAvailability.js',
      'socketConfig.js',
      'socketRedisAdapter.js',
    ];

    for (const file of foundation) {
      const source = fs.readFileSync(path.join(socketDir, file), 'utf8');

      assert.doesNotMatch(
        source,
        /from '.*models\/Chat/,
        `src/socket/${file} must not import a chat model directly`,
      );
    }
  });

  // 33.3/33.4 landed the conversation REST surface + read-only history and
  // 33.7 added the caller-only read-cursor route, so the earlier "no chat
  // route/controller/validator" pin is inverted: those files must exist and
  // /messages (read-only history) + /read (33.7 cursor advance) are present,
  // but the surface must stop there — no REST send, no edit-history read,
  // no receipt fields, no attachments may appear in the chat router yet.
  test('the 33.3/33.4 REST surface exists and stops at read-only history', () => {
    for (const file of [
      'routes/chat/chatRoutes.js',
      'controllers/chat/chatController.js',
      'validators/chat/chatValidators.js',
      'services/chat/chatService.js',
    ]) {
      assert.ok(
        fs.existsSync(path.join(here, '..', 'src', file)),
        `${file} must exist in 33.3/33.4`,
      );
    }

    const router = fs.readFileSync(
      path.join(here, '..', 'src', 'routes', 'chat', 'chatRoutes.js'),
      'utf8',
    );

    assert.ok(router.includes('/messages'), 'read-only history must exist (33.4)');
    assert.ok(router.includes('/read'), 'read-cursor route must exist (33.7)');

    for (const forbidden of ['/send', '/edits', 'unread', 'attachments']) {
      assert.ok(
        !router.includes(forbidden),
        `chatRoutes must not expose ${forbidden} (later unit)`,
      );
    }
  });

  // 33.5 registers join/leave/send, 33.6 adds edit/delete and 33.7 adds
  // readUpTo, so the earlier "no chat events" pin is inverted again: the
  // ONLY chat events that may exist are join / leave / message:send /
  // message:edit / message:delete / readUpTo (client→server) and
  // message:created / message:updated / message:deleted (server→client).
  // Anything surveillance-shaped (typing, presence, last-seen, per-message
  // receipt broadcasts) stays forbidden across the whole socket layer.
  test('only the 33.5/33.6/33.7 chat events exist; no presence/typing/seen-by', () => {
    const socketDir = path.join(here, '..', 'src', 'socket');
    const combined = fs
      .readdirSync(socketDir)
      .filter((n) => n.endsWith('.js'))
      .map((n) => fs.readFileSync(path.join(socketDir, n), 'utf8'))
      .join('\n');

    // 33.9-fix: authenticated listeners are registered through guard(socket,
    // log, '<event>', ...) so a throwing service becomes a RETRYABLE ack
    // instead of an unhandled rejection. Detect BOTH registration shapes
    // (the raw sync stubs and the guarded listeners) — the pin is about
    // WHICH events exist, not how they are wired.
    const registered = new Set(
      [
        ...combined.matchAll(/socket\.on\(\s*'(chat:[a-zA-Z:]+)'/g),
        ...combined.matchAll(/guard\(socket, log, '(chat:[a-zA-Z:]+)'/g),
      ].map((m) => m[1])
    );

    for (const allowed of [
      'chat:join', 'chat:leave', 'chat:message:send',
      'chat:message:edit', 'chat:message:delete', 'chat:readUpTo',
    ]) {
      assert.ok(registered.has(allowed), `${allowed} must be registered (33.5/33.6/33.7)`);
    }

    for (const emitted of [
      'chat:message:created', 'chat:message:updated', 'chat:message:deleted',
      // 33.8-fix: data-less list-change nudge to member personal rooms.
      'chat:conversations:changed',
    ]) {
      assert.ok(combined.includes(`'${emitted}'`), `${emitted} must be emitted`);
    }

    // 33.7 added chat:readUpTo (the caller's own C1 cursor, ACK-only), so
    // 'chat:read' as a blanket substring can no longer be forbidden. The
    // surveillance-shaped events and any per-message receipt broadcast stay
    // forbidden.
    for (const forbidden of [
      'chat:typing', 'chat:presence', 'chat:lastSeen',
      'chat:readReceipt', 'chat:seenBy',
    ]) {
      assert.ok(!combined.includes(forbidden), `${forbidden} must not exist`);
    }
  });

  test('the socket folder holds the foundation + the 33.5 chat modules', () => {
    const files = fs
      .readdirSync(path.join(here, '..', 'src', 'socket'))
      .filter((name) => name.endsWith('.js'))
      .sort();

    assert.deepEqual(files, [
      'chatSocketHandlers.js',
      'chatSocketValidators.js',
      'initSocketServer.js',
      // 33.8-fix: REST→socket list-change nudge seam (data-less event).
      'realtimeNudge.js',
      'socketAuth.js',
      'socketAvailability.js',
      'socketConfig.js',
      'socketRedisAdapter.js',
    ]);
  });

  // Inverted in 33.8 (authorized frontend unit): the frontend now carries
  // exactly the approved socket.io-client dependency. The 33.1-era halves
  // that still hold: no stray frontend socket dir, and no OTHER socket
  // package slipped in.
  test('frontend socket footprint is exactly socket.io-client (33.8)', () => {
    const frontend = path.join(here, '..', '..', 'Frontend');
    const socketDir = path.join(frontend, 'src', 'services', 'socket');
    const pkg = JSON.parse(fs.readFileSync(path.join(frontend, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

    assert.ok(!fs.existsSync(socketDir));
    assert.ok(deps.includes('socket.io-client'), '33.8 approved dependency must exist');
    assert.ok(
      !deps.some((name) => name.includes('socket.io') && name !== 'socket.io-client'),
      'no socket package beyond the approved client',
    );
  });

  test('no presence, typing, last-seen or activity tracking exists anywhere in the socket layer', () => {
    const combined = [
      'socketConfig.js',
      'socketAuth.js',
      'socketAvailability.js',
      'socketRedisAdapter.js',
      'initSocketServer.js',
    ]
      .map((name) => stripComments(readSocket(name)))
      .join('\n');

    for (const forbidden of ['lastSeen', 'isOnline', 'isIdle', 'trackUser', 'presenceState']) {
      assert.ok(!combined.includes(forbidden), `${forbidden} must not exist — no surveillance`);
    }
  });

  test('CHAT_SOCKET_ENABLED is declared in .env.example with a placeholder only', () => {
    const example = fs.readFileSync(path.join(here, '..', '.env.example'), 'utf8');

    assert.match(example, /CHAT_SOCKET_ENABLED=false/);
    assert.ok(!/CHAT_[A-Z_]*(SECRET|PASSWORD|KEY)/.test(example));
  });
});
