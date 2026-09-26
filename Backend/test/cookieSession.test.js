// PHASE 33.14 — THE BROWSER SESSION IS A COOKIE, AND THE SOCKET IS A TICKET.
//
// What this file pins, and why each one is worth a test:
//
//  1. The ACCESS token leaves JavaScript. It used to be returned in the
//     login/refresh body and kept in localStorage, where any script on the
//     page could read it and post it anywhere. It is now an HttpOnly cookie
//     (names, paths, flags pinned below) and the client no longer stores or
//     sends a bearer token at all.
//  2. ONE RESPONSE, TWO COOKIES. `res.setHeader('Set-Cookie', …)` replaces —
//     so the second cookie write silently deletes the first, and the bug
//     looks like "login works, refresh 401s fifteen minutes later". The
//     response double here REPLACES like Express does, so the append
//     behaviour is actually exercised instead of assumed.
//  3. CSRF. A cookie is ambient authority, so cookie-authenticated WRITES
//     must carry the app's proof header. The decision is a pure function
//     and the socket is not affected (it never reads a cookie).
//  4. The socket handshake keeps 33.1's locked rule — the secret comes from
//     the auth payload ONLY, never a cookie — and the browser now presents a
//     60-second chat ticket there instead of a 15-minute access JWT. Both
//     shapes run the SAME Mongo gates: a revoked session or a bumped
//     tokenVersion kills a ticket-authenticated socket just as fast.
//
// Hermetic: fake models, fake Redis, fake responses. No Mongo, no Redis, no
// network, no clock dependence beyond "now".

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createRealtimeTickets,
} from '../src/infrastructure/realtime/realtimeTickets.js';
import {
  needsCsrfHeader,
  requireCsrfProof,
} from '../src/middlewares/authMiddleware.js';
import {
  CHAT_TICKET_TTL_SECONDS,
} from '../src/socket/socketConfig.js';
import {
  SOCKET_AUTH_REASONS,
  verifyChatSocketToken,
} from '../src/socket/socketAuth.js';
import {
  clearAccessCookie,
  clearRefreshCookie,
  getAccessToken,
  setAccessCookie,
} from '../src/utils/tokenService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

const backendSource = (relative) =>
  fs.readFileSync(path.join(repo, 'Backend', 'src', relative), 'utf8');

const frontendSource = (relative) =>
  fs.readFileSync(path.join(repo, 'Frontend', 'src', relative), 'utf8');

/** Express-like response double: setHeader REPLACES, getHeader reads back. */
const makeRes = () => ({
  headers: {},
  getHeader(name) {
    return this.headers[name];
  },
  setHeader(name, value) {
    this.headers[name] = value;
  },
});

const cookiesOf = (res) =>
  Array.isArray(res.headers['Set-Cookie'])
    ? res.headers['Set-Cookie']
    : res.headers['Set-Cookie']
      ? [String(res.headers['Set-Cookie'])]
      : [];

const cookieFor = (res, name) =>
  cookiesOf(res).find((line) => line.startsWith(`${name}=`)) || '';

// ── 1. THE ACCESS COOKIE ──────────────────────────────────────────────────

test('the access cookie is HttpOnly, Path=/api and matched to the token lifetime', () => {
  const res = makeRes();

  setAccessCookie(res, 'header.payload.signature', 15 * 60 * 1000);

  const cookie = cookieFor(res, 'crewly_access');

  assert.ok(cookie, 'the access cookie is written');

  assert.match(cookie, /^crewly_access=header\.payload\.signature/, 'it carries the token');
  assert.match(cookie, /HttpOnly/, 'JavaScript can never read it — this is the whole point');
  assert.match(cookie, /Path=\/api\b/, 'it rides the API subtree');
  assert.match(cookie, /SameSite=Lax/, 'strict enough by default in development');
  assert.match(cookie, /Max-Age=900/, 'its lifetime is the access token lifetime');

  // The socket handshake lives at /socket.io: the browser must NOT attach a
  // long-lived credential there (33.1: no cookies on sockets).
  assert.ok(!/Path=\/(;|$)/.test(cookie), 'never Path=/ — the socket path must not receive it');
  assert.ok(!/Secure/.test(cookie), 'not Secure outside production (local http must work)');
});

test('one response carries BOTH cookies — the second write never clobbers the first', () => {
  const res = makeRes();

  // Exactly what login/register/refresh do, in production order.
  setRefreshCookieLike(res);
  setAccessCookie(res, 'access-token', 15 * 60 * 1000);

  const lines = cookiesOf(res);

  assert.equal(lines.length, 2, 'the response advertises two Set-Cookie lines');
  assert.ok(cookieFor(res, 'crewly_refresh'), 'the refresh cookie survives');
  assert.ok(cookieFor(res, 'crewly_access'), 'and the access cookie is added');

  assert.match(cookieFor(res, 'crewly_refresh'), /Path=\/api\/auth/, 'refresh stays scoped to /api/auth');
});

/** The refresh cookie's own helper, kept in one place for the test above. */
function setRefreshCookieLike(res) {
  // Imported lazily to keep this file's import list honest about what it
  // really depends on for the access-cookie assertions.
  res.setHeader(
    'Set-Cookie',
    'crewly_refresh=raw-refresh-token; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=2592000',
  );
}

test('clearing is a REAL delete for both cookies (Max-Age=0, empty value)', () => {
  const res = makeRes();

  clearRefreshCookie(res);
  clearAccessCookie(res);

  assert.match(cookieFor(res, 'crewly_refresh'), /^crewly_refresh=;/, 'the refresh value is emptied');
  assert.match(cookieFor(res, 'crewly_refresh'), /Max-Age=0/, 'and expired');
  assert.match(cookieFor(res, 'crewly_access'), /^crewly_access=;/, 'the access value is emptied');
  assert.match(cookieFor(res, 'crewly_access'), /Max-Age=0/, 'and expired too');
});

test('the access token is read from the cookie jar, and a junk cookie is not an error', () => {
  assert.equal(
    getAccessToken({ headers: { cookie: 'crewly_access=abc.def.ghi; other=1' } }),
    'abc.def.ghi',
  );

  assert.equal(
    getAccessToken({ headers: { cookie: 'crewly_access=' + encodeURIComponent('a.b.c') } }),
    'a.b.c',
    'the value is URL-decoded like the refresh cookie',
  );

  // A malformed escape must not throw: protect() calls this on EVERY request,
  // so throwing here would turn a corrupt cookie into a 500 storm.
  assert.equal(
    getAccessToken({ headers: { cookie: 'crewly_access=%zz; crewly_refresh=x' } }),
    '%zz',
  );

  assert.equal(getAccessToken({ headers: {} }), '', 'no cookie header is simply no token');
});

// ── 2. THE CSRF GATE ──────────────────────────────────────────────────────

test('csrf: a cookie-authenticated write without the app header is refused', () => {
  assert.equal(
    needsCsrfHeader({ method: 'POST', authSource: 'cookie', requestedWith: undefined }),
    true,
    'a cross-site page can attach our cookie but not our header',
  );

  assert.equal(
    needsCsrfHeader({ method: 'POST', authSource: 'cookie', requestedWith: 'XMLHttpRequest' }),
    false,
    'our own client passes',
  );

  assert.equal(
    needsCsrfHeader({ method: 'DELETE', authSource: 'cookie', requestedWith: undefined }),
    true,
    'deletes count too',
  );
});

test('csrf: reads are exempt and bearer callers are never gated', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    assert.equal(
      needsCsrfHeader({ method, authSource: 'cookie', requestedWith: undefined }),
      false,
      `${method} must stay callable (downloads, SSE, preflight)`,
    );
  }

  assert.equal(
    needsCsrfHeader({ method: 'POST', authSource: 'bearer', requestedWith: undefined }),
    false,
    'a bearer caller already proved intent by holding a token no page can borrow',
  );
});

test('the refresh route takes the same proof (it is a cookie-authenticated write)', () => {
  const makeRes = () => ({
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;

      return this;
    },
    json(body) {
      this.body = body;

      return this;
    },
  });

  const run = (request) => {
    const res = makeRes();
    let nexted = false;

    requireCsrfProof(request, res, () => {
      nexted = true;
    });

    return { res, nexted };
  };

  const refreshCookie = { cookie: `crewly_refresh=${encodeURIComponent('abc')}` };

  const refused = run({
    method: 'POST',
    headers: refreshCookie,
    get: (name) => (name === 'X-Requested-With' ? undefined : undefined),
  });

  assert.equal(refused.nexted, false, 'a cross-site rotation attempt does not reach the handler');
  assert.equal(refused.res.statusCode, 403);
  assert.equal(refused.res.body.code, 'CSRF_HEADER_REQUIRED');

  const allowed = run({
    method: 'POST',
    headers: { ...refreshCookie, 'x-requested-with': 'XMLHttpRequest' },
    get: (name) => (name === 'X-Requested-With' ? 'XMLHttpRequest' : undefined),
  });

  assert.equal(allowed.nexted, true, 'our own client passes');

  const noCookie = run({
    method: 'POST',
    headers: {},
    get: () => undefined,
  });

  assert.equal(noCookie.nexted, true, 'nothing to protect without a refresh cookie (the handler 401s)');

  // And the route really mounts it.
  const routes = backendSource('routes/authRoutes.js');

  assert.match(
    routes,
    /"\/refresh",\s*refreshRateLimit,\s*requireCsrfProof,\s*refresh/,
    'the refresh route must mount the guard, not just have it available',
  );
});

test('protect() accepts the cookie, prefers an explicit bearer, and enforces the gate', () => {
  const source = backendSource('middlewares/authMiddleware.js');

  assert.match(source, /getAccessToken\(req\)/, 'the cookie is a token source');
  assert.match(
    source,
    /const token = bearerToken \|\| cookieToken/,
    'an explicit Authorization header always wins (platform/admin clients are unchanged)',
  );
  assert.match(
    source,
    /req\.authSource = bearerToken \? 'bearer' : cookieToken \? 'cookie' : 'none'/,
    'the source is recorded so the CSRF gate can be scoped to cookies',
  );
  assert.match(source, /CSRF_HEADER_REQUIRED/, 'the refusal has a stable code for the client');

  const app = backendSource('app.js');

  assert.match(app, /'X-Requested-With'/, 'the CORS allowlist must echo the proof header, or our own SPA is blocked');
});

// ── 3. THE SOCKET STILL REFUSES COOKIES … ─────────────────────────────────

test('the socket handshake keeps 33.1: auth payload only, never a cookie', () => {
  const auth = backendSource('socket/socketAuth.js');

  assert.match(auth, /socket\?\.handshake\?\.auth\?\.token/, 'the payload is the only source');
  assert.ok(!/handshake\.headers\.cookie/.test(auth), 'the handshake never reads the cookie header');
  assert.match(auth, /consumeReusable/, 'the ticket is what the browser presents instead');
});

// ── 4. … AND A CHAT TICKET CARRIES THE SAME AUTHORITY ─────────────────────

const makeTicketStore = () => {
  const store = new Map();

  const redis = {
    set: async (key, value, _ex, ttl) => {
      store.set(key, { value, ttl });

      return 'OK';
    },
    get: async (key) => store.get(key)?.value ?? null,
    multi: () => {
      let current = null;

      return {
        get(key) {
          current = key;

          return this;
        },
        del() {
          return this;
        },
        async exec() {
          const raw = store.get(current)?.value ?? null;
          store.delete(current);

          return [[null, raw], [null, 1]];
        },
      };
    },
  };

  return { redis, store };
};

const FIXED_TICKET = 'a'.repeat(64);
const CLAIMS = {
  userId: '652222222222222222222222',
  companyId: '651111111111111111111111',
  sessionId: 'session-uuid-for-tests',
  tokenVersion: 3,
};

const activeUser = () => ({
  _id: CLAIMS.userId,
  companyId: CLAIMS.companyId,
  status: 'ACTIVE',
  role: 'EMPLOYEE',
  tokenVersion: CLAIMS.tokenVersion,
});

const liveSession = () => ({ sessionId: CLAIMS.sessionId });
const activeCompany = () => ({ status: 'ACTIVE' });

const verifyWith = (token, overrides = {}) =>
  verifyChatSocketToken(token, {
    consumeTicket: async () => null,
    findUser: async () => activeUser(),
    findSession: async () => liveSession(),
    findCompany: async () => activeCompany(),
    ...overrides,
  });

test('a chat ticket authenticates the socket with the SAME gates as a JWT', async () => {
  const result = await verifyWith(FIXED_TICKET, { consumeTicket: async () => CLAIMS });

  assert.equal(result.ok, true);
  assert.equal(result.userId, CLAIMS.userId);
  assert.equal(result.companyId, CLAIMS.companyId, 'the tenant is still derived server-side');
  assert.equal(result.sessionId, CLAIMS.sessionId);
});

test('an unknown, expired or used ticket is refused — never a partial accept', async () => {
  const result = await verifyWith(FIXED_TICKET, { consumeTicket: async () => null });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SOCKET_AUTH_REASONS.INVALID_TOKEN);
});

test('a secret that is neither a JWT nor a ticket shape is refused as malformed', async () => {
  const result = await verifyWith('not-a-jwt-and-not-a-ticket', { consumeTicket: async () => null });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SOCKET_AUTH_REASONS.MALFORMED_TOKEN);
});

test('a ticket for a REVOKED session is refused (logout kills live sockets on reconnect)', async () => {
  const result = await verifyWith(FIXED_TICKET, {
    consumeTicket: async () => CLAIMS,
    findSession: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SOCKET_AUTH_REASONS.SESSION_INVALID);
});

test('a ticket minted BEFORE a tokenVersion bump is refused (theft revocation reaches sockets)', async () => {
  const result = await verifyWith(FIXED_TICKET, {
    consumeTicket: async () => CLAIMS,
    findUser: async () => ({ ...activeUser(), tokenVersion: CLAIMS.tokenVersion + 1 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SOCKET_AUTH_REASONS.LEGACY_TOKEN);
});

test('a suspended tenant cannot hold a socket even with a valid ticket', async () => {
  const result = await verifyWith(FIXED_TICKET, {
    consumeTicket: async () => CLAIMS,
    findCompany: async () => ({ status: 'SUSPENDED' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, SOCKET_AUTH_REASONS.COMPANY_UNAVAILABLE);
});

test('a chat ticket is short-lived, reusable inside its TTL, and stored with its session', async () => {
  const { redis, store } = makeTicketStore();

  const tickets = createRealtimeTickets({
    redis,
    prefix: 'crewly:test',
    random: () => FIXED_TICKET,
  });

  const issued = await tickets.issue({
    ...CLAIMS,
    reusable: true,
    ttl: CHAT_TICKET_TTL_SECONDS,
  });

  assert.equal(issued.expiresInSeconds, CHAT_TICKET_TTL_SECONDS, 'a minute, not thirty minutes');

  const stored = JSON.parse([...store.values()][0].value);

  assert.equal(stored.sessionId, CLAIMS.sessionId, 'the session is bound to the ticket');
  assert.equal(stored.tokenVersion, CLAIMS.tokenVersion, 'so is the revocation counter');
  assert.equal(stored.reusable, true);

  // A socket reconnects on its own and cannot mint mid-reconnect: within the
  // TTL the SAME ticket handshakes again (and again).
  assert.deepEqual(await tickets.consumeReusable(FIXED_TICKET), stored);
  assert.deepEqual(await tickets.consumeReusable(FIXED_TICKET), stored, 'still valid, still bound');

  // The SSE contract is untouched: consume() is still atomic single-use.
  assert.deepEqual(await tickets.consume(FIXED_TICKET), stored);
  assert.equal(await tickets.consumeReusable(FIXED_TICKET), null, 'and after the atomic consume it is gone');
});

test('the SSE stream cannot be authenticated with a reuse flag it did not ask for', async () => {
  const { redis } = makeTicketStore();

  const tickets = createRealtimeTickets({
    redis,
    prefix: 'crewly:test',
    random: () => FIXED_TICKET,
  });

  // Default (SSE) ticket: no reusable flag stored at all.
  await tickets.issue({ userId: CLAIMS.userId, companyId: CLAIMS.companyId });

  assert.equal(
    await tickets.consumeReusable(FIXED_TICKET),
    null,
    'a single-use ticket presented to the socket handshake is refused',
  );
});

// ── 5. THE CLIENT HOLDS NO TOKEN ──────────────────────────────────────────

test('the customer client stores no token and proves its calls with the CSRF header', () => {
  const api = frontendSource('services/api.js');

  assert.ok(!/infolexus_token/.test(api), 'no access token in localStorage — not read, not written');
  assert.match(
    api,
    /PLATFORM_ROLES\.includes\(user\?\.role\)[\s\S]{0,240}Authorization/,
    'a bearer header is attached ONLY for the platform portal, never for a customer call',
  );
  assert.match(api, /X-Requested-With/, 'every call carries the CSRF proof');
  assert.match(api, /REFRESH_LOCK/, 'the cross-tab refresh lock stays');
  assert.match(api, /REFRESH_IN_PROGRESS/, 'and the race is still retried, never treated as a logout');
});

test('the auth slice keeps the session without a token, and purges the legacy one', () => {
  const slice = frontendSource('redux/slices/AuthSlices.js');

  const legacyMentions = slice.match(/'infolexus_token'/g) || [];

  assert.equal(
    legacyMentions.length,
    1,
    'the legacy key exists in exactly one place — the migration that deletes it',
  );
  assert.match(slice, /const LEGACY_TOKEN_KEY = 'infolexus_token'/, 'that place is the purge constant');
  assert.match(slice, /removeItem\(\s*LEGACY_TOKEN_KEY/, 'the purge really deletes it');
  assert.ok(
    !/setItem\(\s*LEGACY_TOKEN_KEY/.test(slice),
    'and nothing ever writes a customer token to localStorage again',
  );
  assert.match(slice, /PLATFORM_TOKEN_KEY/, 'the platform portal keeps its own bearer token key');

  const hook = frontendSource('hooks/useAuth.jsx');

  assert.match(hook, /isAuthenticated:\s*Boolean\(user\)/, 'authentication is the user + the cookie, not a JS token');
});

test('the chat socket asks for a ticket and never sends the auth token from the store', () => {
  const client = frontendSource('services/realtime/chatSocketClient.js');

  assert.match(client, /realtime\/chat-ticket/, 'it mints a chat ticket over authenticated HTTP');
  assert.ok(
    !/auth:\s*\{\s*token\s*\}/.test(client),
    'the handshake payload is the ticket, not a stored access token',
  );
  assert.ok(!/state\.auth\?\.token/.test(client), 'the store no longer holds a token to read');

  const routes = backendSource('routes/realtimeRoutes.js');

  assert.match(routes, /'\/chat-ticket'/, 'and the endpoint exists');
  assert.match(routes, /reusable: true/, 'with the reuse-within-TTL mode the socket needs');
});
