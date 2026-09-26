// ============================================================
//  SESSION REFRESH RESILIENCE (HERMETIC).
//
//  No Mongo, no Redis, no HTTP. The REAL session service
//  (src/utils/tokenService.js) runs against in-memory fakes of the
//  RefreshToken / SecuritySession / User / CompanySecurityPolicy /
//  SecurityEvent / AuditLog statics (repo pattern: chatModeration.test.js).
//
//  The bug this suite exists for — "my session expires too fast":
//
//    · the refresh cookie is shared by every tab, and rotation is SINGLE USE;
//    · two tabs whose access token expires together rotate the same token
//      twice — the second presentation was read as THEFT, so the whole token
//      family was revoked AND User.tokenVersion was bumped: every tab, every
//      device, signed out mid-work;
//    · and ANY failure in the refresh handler cleared the refresh cookie,
//      turning a transient 5xx into a permanent logout.
//
//  Pinned here:
//    · a rotation race inside the grace window answers 409
//      REFRESH_IN_PROGRESS, keeps the family, keeps the cookie, bumps nothing;
//    · reuse OUTSIDE the window is still theft: family revoked, tokenVersion
//      bumped, cookie cleared (the security property is NOT weakened);
//    · an explicitly revoked token never gets the grace window;
//    · the happy rotation still rotates, cookie and all;
//    · the frontend coordinates tabs (Web Locks) and retries on the race code;
//    · the controller clears the cookie for a DEAD session only.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_refresh_resilience';
process.env.REDIS_ENABLED ||= 'false';

import AuditLog from '../src/models/AuditLog.js';
import CompanySecurityPolicy from '../src/models/CompanySecurityPolicy.js';
import RefreshToken from '../src/models/RefreshToken.js';
import SecurityEvent from '../src/models/SecurityEvent.js';
import SecuritySession from '../src/models/SecuritySession.js';
import User from '../src/models/User.js';
import { hashToken } from '../src/utils/securityPolicy.js';
import { rotateRefreshToken, REFRESH_RACE_GRACE_MS } from '../src/utils/tokenService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = (rel) => fs.readFileSync(path.join(here, '..', '..', 'Frontend', 'src', rel), 'utf8');
const backend = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');

const RAW_TOKEN = 'raw-refresh-token-for-tests';
const COMPANY_ID = '651111111111111111111111';
const USER_ID = '652222222222222222222222';
const SESSION_ID = 'session-uuid-for-tests';

const POLICY = {
  sessions: { accessTokenMinutes: 15, refreshTokenDays: 30, idleTimeoutMinutes: 480, maximumActiveSessions: 10 },
};

// ── the fakes ─────────────────────────────────────────────────────────────

const installFakes = ({ token, session, user = {}, policy = POLICY } = {}) => {
  const calls = {
    refreshFamilyRevoked: 0,
    sessionFamilyRevoked: 0,
    tokenVersionBumped: 0,
    markedUsed: 0,
    created: [],
    events: [],
    audits: [],
    tokenSaved: 0,
    sessionSaved: 0,
  };

  const original = {
    rtFindOne: RefreshToken.findOne,
    rtUpdateOne: RefreshToken.updateOne,
    rtUpdateMany: RefreshToken.updateMany,
    rtCreate: RefreshToken.create,
    ssFindOne: SecuritySession.findOne,
    ssUpdateMany: SecuritySession.updateMany,
    userFindOne: User.findOne,
    userUpdateOne: User.updateOne,
    policyFindOneAndUpdate: CompanySecurityPolicy.findOneAndUpdate,
    eventCreate: SecurityEvent.create,
    auditCreate: AuditLog.create,
  };

  RefreshToken.findOne = async (filter) => {
    if (!token) return null;
    if (filter?.tokenHash && filter.tokenHash !== token.tokenHash) return null;

    return { ...token, save: async () => { calls.tokenSaved += 1; } };
  };

  RefreshToken.updateOne = async () => {
    calls.markedUsed += 1;

    return { modifiedCount: 1 };
  };

  RefreshToken.updateMany = async () => {
    calls.refreshFamilyRevoked += 1;

    return { modifiedCount: 1 };
  };

  RefreshToken.create = async (doc) => {
    calls.created.push(doc);

    return doc;
  };

  SecuritySession.findOne = async () => {
    if (!session) return null;

    return {
      ...session,
      save: async () => { calls.sessionSaved += 1; },
    };
  };

  SecuritySession.updateMany = async () => {
    calls.sessionFamilyRevoked += 1;

    return { modifiedCount: 1 };
  };

  User.findOne = async () => ({
    _id: USER_ID,
    companyId: COMPANY_ID,
    status: 'ACTIVE',
    tokenVersion: 3,
    ...user,
  });

  User.updateOne = async () => {
    calls.tokenVersionBumped += 1;

    return { modifiedCount: 1 };
  };

  CompanySecurityPolicy.findOneAndUpdate = () => ({
    lean: async () => policy,
  });

  SecurityEvent.create = async (doc) => {
    calls.events.push(doc);

    return doc;
  };

  AuditLog.create = async (doc) => {
    calls.audits.push(doc);

    return doc;
  };

  return {
    calls,
    restore: () => {
      RefreshToken.findOne = original.rtFindOne;
      RefreshToken.updateOne = original.rtUpdateOne;
      RefreshToken.updateMany = original.rtUpdateMany;
      RefreshToken.create = original.rtCreate;
      SecuritySession.findOne = original.ssFindOne;
      SecuritySession.updateMany = original.ssUpdateMany;
      User.findOne = original.userFindOne;
      User.updateOne = original.userUpdateOne;
      CompanySecurityPolicy.findOneAndUpdate = original.policyFindOneAndUpdate;
      SecurityEvent.create = original.eventCreate;
      AuditLog.create = original.auditCreate;
    },
  };
};

const makeToken = (overrides = {}) => ({
  _id: '653333333333333333333333',
  user: USER_ID,
  companyId: COMPANY_ID,
  session: '654444444444444444444444',
  sessionId: SESSION_ID,
  tokenFamily: 'family-uuid',
  tokenHash: hashToken(RAW_TOKEN),
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  usedAt: null,
  revokedAt: null,
  ...overrides,
});

const makeSession = () => ({
  _id: '654444444444444444444444',
  sessionId: SESSION_ID,
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  revokedAt: null,
});

const makeReq = () => ({
  ip: '127.0.0.1',
  headers: {
    cookie: `crewly_refresh=${encodeURIComponent(RAW_TOKEN)}`,
    'user-agent': 'node-test-agent',
  },
});

/*
 * A faithful-enough Express response double: `setHeader` REPLACES (exactly
 * like Express) and `getHeader` reads back, which is what production code
 * (`appendCookie`) uses to append a second cookie instead of clobbering the
 * first. A double that always overwrote would hide that bug, so it does not.
 */
const makeRes = () => ({
  headers: {},
  getHeader(name) {
    return this.headers[name];
  },
  setHeader(name, value) {
    this.headers[name] = value;
  },
});

const cookiesOf = (res) => {
  const raw = res.headers['Set-Cookie'];

  if (Array.isArray(raw)) return raw;

  return raw ? [String(raw)] : [];
};

/** The cookie line for one name (default: the refresh cookie). */
const cookieOf = (res, name = 'crewly_refresh') =>
  cookiesOf(res).find((line) => line.startsWith(`${name}=`)) || '';

// ── 1. THE RACE ───────────────────────────────────────────────────────────

test('a rotation race inside the grace window is NOT theft: the family and the cookie survive', async () => {
  // The other tab rotated 5 seconds ago: this presentation is one instant old.
  const token = makeToken({ usedAt: new Date(Date.now() - 5000) });
  const fakes = installFakes({ token, session: makeSession() });
  const res = makeRes();

  try {
    await assert.rejects(
      () => rotateRefreshToken({ req: makeReq(), res }),
      (error) => {
        assert.equal(error.statusCode, 409, 'a race answers 409, not 401');
        assert.equal(error.code, 'REFRESH_IN_PROGRESS', 'with a code the client can retry on');

        return true;
      },
    );

    assert.equal(fakes.calls.refreshFamilyRevoked, 0, 'the token family is NOT revoked');
    assert.equal(fakes.calls.sessionFamilyRevoked, 0, 'the session family is NOT revoked');
    assert.equal(fakes.calls.tokenVersionBumped, 0, 'tokenVersion is NOT bumped (that signs out every device)');
    assert.equal(fakes.calls.tokenSaved, 0, 'nothing is marked as detected theft');

    assert.equal(cookieOf(res), '', 'the winning tab\'s fresh cookie is NOT cleared');

    const raceEvent = fakes.calls.events.find((event) => event.event === 'REFRESH_TOKEN_CONCURRENT_REFRESH');

    assert.ok(raceEvent, 'the race is recorded as its own security event');
    assert.equal(raceEvent.success, true, 'recorded as a normal, successful outcome');
    assert.equal(raceEvent.companyId, COMPANY_ID, 'metadata only: tenant + ids');
    assert.equal(raceEvent.sessionId, SESSION_ID);
  } finally {
    fakes.restore();
  }
});

// ── 2. SECURITY IS NOT WEAKENED ───────────────────────────────────────────

test('reuse OUTSIDE the window is still theft: family revoked, tokenVersion bumped, cookie cleared', async () => {
  const token = makeToken({
    usedAt: new Date(Date.now() - (REFRESH_RACE_GRACE_MS + 5000)),
  });

  const fakes = installFakes({ token, session: makeSession() });
  const res = makeRes();

  try {
    await assert.rejects(
      () => rotateRefreshToken({ req: makeReq(), res }),
      (error) => {
        assert.equal(error.statusCode, 401, 'theft is a 401');
        assert.match(error.message, /revoked for security reasons/i);

        return true;
      },
    );

    assert.equal(fakes.calls.tokenSaved, 1, 'the token row is marked as replayed');
    assert.equal(fakes.calls.refreshFamilyRevoked, 1, 'every refresh token in the family is revoked');
    assert.equal(fakes.calls.sessionFamilyRevoked, 1, 'and every session in the family');
    assert.equal(fakes.calls.tokenVersionBumped, 1, 'and every access token is invalidated');

    assert.match(cookieOf(res), /Max-Age=0/, 'the refresh cookie is cleared on real theft');

    const reuseEvent = fakes.calls.events.find((event) => event.event === 'REFRESH_TOKEN_REUSE_DETECTED');

    assert.ok(reuseEvent, 'the theft is recorded');
    assert.equal(reuseEvent.success, false, 'and recorded as a failure');
    assert.equal(fakes.calls.audits.length, 1, 'a critical audit row is written');
  } finally {
    fakes.restore();
  }
});

test('an explicitly revoked token never gets the grace window', async () => {
  const token = makeToken({
    revokedAt: new Date(),
    usedAt: new Date(Date.now() - 1000),
  });

  const fakes = installFakes({ token, session: makeSession() });

  try {
    await assert.rejects(
      () => rotateRefreshToken({ req: makeReq(), res: makeRes() }),
      (error) => {
        assert.equal(error.statusCode, 401);

        return true;
      },
    );

    assert.equal(fakes.calls.refreshFamilyRevoked, 1, 'a revoked token is theft, however young');
  } finally {
    fakes.restore();
  }
});

// ── 3. THE HAPPY PATH STILL ROTATES ───────────────────────────────────────

test('a healthy refresh still rotates, sets a fresh cookie and extends the session', async () => {
  const token = makeToken();
  const session = makeSession();
  const fakes = installFakes({ token, session });
  const res = makeRes();

  try {
    const result = await rotateRefreshToken({ req: makeReq(), res });

    assert.ok(result.accessToken, 'an access token is issued');
    assert.equal(result.accessTokenExpiresIn, POLICY.sessions.accessTokenMinutes * 60);

    assert.equal(fakes.calls.markedUsed, 1, 'the presented token is marked used (single use)');
    assert.equal(fakes.calls.created.length, 1, 'exactly one successor token is created');
    assert.notEqual(fakes.calls.created[0].tokenHash, token.tokenHash, 'the successor is a different secret');
    assert.equal(fakes.calls.created[0].tokenFamily, token.tokenFamily, 'the family continues');

    assert.match(cookieOf(res), /crewly_refresh=/, 'the new refresh token rides the cookie');
    assert.match(cookieOf(res), /HttpOnly/, 'still HttpOnly');
    assert.match(cookieOf(res), /Max-Age=\d{3,}/, 'and still long-lived');

    assert.equal(fakes.calls.sessionSaved, 1, 'the session row is touched (lastActivityAt / expiry)');
    assert.ok(
      fakes.calls.events.some((event) => event.event === 'REFRESH_TOKEN_ROTATED'),
      'a normal rotation is recorded',
    );
  } finally {
    fakes.restore();
  }
});

test('a missing cookie is a plain 401 — no family work, no cookie write', async () => {
  const fakes = installFakes({ token: makeToken(), session: makeSession() });
  const res = makeRes();

  try {
    await assert.rejects(
      () => rotateRefreshToken({ req: { headers: {} }, res }),
      (error) => {
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /missing/i);

        return true;
      },
    );

    assert.equal(fakes.calls.refreshFamilyRevoked, 0, 'a missing cookie revokes nothing');
    assert.equal(cookieOf(res), '', 'and writes no cookie header');
  } finally {
    fakes.restore();
  }
});

// ── 4. THE CLIENT + THE CONTROLLER (source pins) ──────────────────────────

test('the browser coordinates tabs and retries the race instead of logging out', () => {
  const api = frontend('services/api.js');

  assert.match(api, /navigator\.locks\.request/, 'tabs take a real cross-tab lock');
  assert.match(api, /REFRESH_LOCK/, 'the lock has a stable name');
  assert.match(api, /REFRESH_IN_PROGRESS/, 'the race code is handled, not swallowed as a logout');

  /*
   * 33.14 INVERTED THIS PIN, deliberately.
   *
   * It used to require the client to re-read localStorage and ADOPT the token
   * another tab had written. There is no client-side token any more: the new
   * cookie is installed by the response itself, so adoption is not a thing the
   * client can or should do — and a client that still read a stored token here
   * would be the regression. Same guarantee, new mechanism: the lock still
   * serialises tabs, and the 409 retry still recovers from the race.
   */
  assert.ok(
    !/readStoredToken|tokenBeforeRefresh/.test(api),
    'the client must not go back to reading/adopting a stored access token',
  );
  assert.ok(
    !/localStorage\.(get|set)Item\(\s*'infolexus_token'/.test(api),
    'and never touches a token in storage again',
  );
});

test('the refresh controller clears the cookie for a dead session only', () => {
  const controller = backend('controllers/securityAuthController.js');

  assert.match(
    controller,
    /statusCode === 401 \|\|\s*statusCode === 403/,
    'only 401/403 may burn the refresh cookie',
  );

  assert.match(
    controller,
    /REFRESH_IN_PROGRESS/,
    'the race answers with its own code before any cookie is touched',
  );

  // The old behaviour — clear unconditionally — must not come back.
  assert.ok(
    !/} catch \(error\) \{\s*clearRefreshCookie\(res\);\s*\n\s*throw new ApiError/.test(controller),
    'the unconditional clearRefreshCookie() in the catch block is gone',
  );
});
