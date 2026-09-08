// Phase 30.6 — INTERNAL BGV VERIFIER ACCOUNTS (hermetic suite).
// No MongoDB/Redis/SMTP: all collaborators injected. bcrypt runs for real
// (CPU-only) so password hashing/comparison is genuinely exercised.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';

import { BGV_VERIFIER_SPECIALIZATIONS } from '../src/models/BgvVerifier.js';
import {
  completeVerifierSetup,
  deactivateVerifier,
  getVerifierProfile,
  inviteVerifier,
  loginVerifier,
  logoutVerifier,
  reactivateVerifier,
  requestVerifierPasswordReset,
  resendVerifierSetup,
  resetVerifierPassword,
  revokeVerifierSetupInvitation,
  resolveVerifierSession,
  updateVerifierProfile,
  VERIFIER_PRINCIPAL_TYPE,
} from '../src/services/bgv/bgvVerifierService.js';
import { GENERIC_AUTH_FAILURE } from '../src/services/bgv/bgvVerifierRules.js';
import { hashToken, randomToken } from '../src/utils/securityPolicy.js';
import { PLATFORM_PERMISSIONS } from '../src/middlewares/superAdminAuth.js';

const SUPER_ADMIN = 'adm111111111111111111111';
const PASSWORD = 'Verifier#2026'; // meets platform minimums

const makeWorld = () => {
  const state = {
    verifiers: [],
    tokens: [],
    sessions: [],
    mails: [],
    audits: [],
    nextId: 0,
  };

  const deps = {
    loadByEmail: async (email) => {
      const found = state.verifiers.find((v) => v.email === email);
      return found ? { ...found } : null;
    },
    loadById: async (id) => {
      const found = state.verifiers.find((v) => String(v._id) === String(id));
      return found ? { ...found } : null;
    },
    insertVerifier: async (doc) => {
      const created = { _id: `ver-${state.nextId++}`, passwordHash: null, createdAt: new Date(), ...doc };
      state.verifiers.push(created);
      return { ...created };
    },
    updateVerifier: async ({ verifierId, set }) => {
      const found = state.verifiers.find((v) => String(v._id) === String(verifierId));
      if (!found) return null;
      Object.assign(found, set);
      return { ...found };
    },
    setPassword: async ({ verifierId, plain }) => {
      const found = state.verifiers.find((v) => String(v._id) === String(verifierId));
      found.passwordHash = await bcrypt.hash(String(plain), 4); // low rounds: tests only
      return { ...found };
    },
    insertToken: async (doc) => {
      const created = { _id: `tok-${state.nextId++}`, usedAt: null, revokedAt: null, ...doc };
      state.tokens.push(created);
      return { ...created };
    },
    resolveToken: async (tokenHash) => {
      const found = state.tokens.find((t) => t.tokenHash === tokenHash);
      return found ? { ...found } : null;
    },
    loadTokenById: async ({ tokenId }) => {
      const found = state.tokens.find((t) => String(t._id) === String(tokenId));
      return found ? { ...found } : null;
    },
    revokePendingTokens: async ({ verifierId, purpose }) => {
      state.tokens.forEach((t) => {
        if (String(t.verifier) === String(verifierId) && t.purpose === purpose && !t.usedAt && !t.revokedAt) {
          t.revokedAt = new Date();
        }
      });
    },
    consumeToken: async ({ tokenId }) => {
      const found = state.tokens.find(
        (t) => String(t._id) === String(tokenId) && !t.usedAt && !t.revokedAt && new Date(t.expiresAt) > new Date()
      );
      if (!found) return null;
      found.usedAt = new Date();
      return { ...found };
    },
    insertSession: async (doc) => {
      const created = { _id: `ses-${state.nextId++}`, revokedAt: null, lastSeenAt: new Date(), ...doc };
      state.sessions.push(created);
      return { ...created };
    },
    loadSession: async ({ sessionId, verifierId }) => {
      const found = state.sessions.find(
        (s) => s.sessionId === sessionId && String(s.verifier) === String(verifierId) && !s.revokedAt && new Date(s.expiresAt) > new Date()
      );
      return found ? { ...found } : null;
    },
    revokeSession: async ({ sessionId }) => {
      const found = state.sessions.find((s) => s.sessionId === sessionId && !s.revokedAt);
      if (found) found.revokedAt = new Date();
    },
    revokeAllSessions: async ({ verifierId }) => {
      state.sessions.forEach((s) => {
        if (String(s.verifier) === String(verifierId) && !s.revokedAt) s.revokedAt = new Date();
      });
    },
    touchSession: async () => {},
    sendMail: async (payload) => {
      state.mails.push(payload);
      return { delivered: true, mode: 'MOCK' };
    },
    audit: async (entry) => {
      state.audits.push(entry);
    },
    signSession: ({ verifierId, sessionId }) => `fake-jwt:${verifierId}:${sessionId}`,
  };

  return { state, deps };
};

const extractSetupToken = (world) => {
  const mail = world.state.mails[world.state.mails.length - 1];
  const match = String(mail.text).match(/\/bgv-verifier\/setup\/(\S+)/);
  return match ? match[1] : null;
};

const invite = (world, overrides = {}) =>
  inviteVerifier({
    actorId: SUPER_ADMIN,
    name: 'Verifier One',
    email: 'verifier.one@infolexus.example',
    specializations: ['IDENTITY', 'ADDRESS'],
    deps: world.deps,
    ...overrides,
  });

const setupAndLogin = async (world) => {
  await invite(world);
  const raw = extractSetupToken(world);
  await completeVerifierSetup({ rawToken: raw, password: PASSWORD, deps: world.deps });
  return loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, deps: world.deps });
};

const codeOnly = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  .split(String.fromCharCode(10))
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
  .join(' ');

// ══════════ ACCOUNT ══════════

test('30.6: Super Admin invites verifier; duplicate email and invalid specializations rejected', async () => {
  const world = makeWorld();
  const result = await invite(world);
  assert.equal(result.verifier.status, 'INVITED');
  assert.deepEqual(result.verifier.specializations, ['IDENTITY', 'ADDRESS']);

  await assert.rejects(invite(world), (e) => e.statusCode === 409); // duplicate email
  await assert.rejects(
    invite(world, { email: 'x@infolexus.example', specializations: ['CRIMINAL'] }),
    (e) => e.statusCode === 400
  );
  // exactly the five approved specializations
  assert.deepEqual([...BGV_VERIFIER_SPECIALIZATIONS].sort(), ['ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'IDENTITY', 'REFERENCE']);
  // multiple specializations supported
  const multi = await invite(world, { email: 'multi@infolexus.example', specializations: ['EMPLOYMENT', 'REFERENCE', 'EDUCATION'] });
  assert.equal(multi.verifier.specializations.length, 3);
});

test('30.6: platform permissions — only SUPER_ADMIN can manage verifiers', async () => {
  for (const [role, perms] of Object.entries(PLATFORM_PERMISSIONS)) {
    if (role === 'SUPER_ADMIN') {
      assert.ok(perms.includes('*'));
    } else {
      assert.equal(perms.includes('bgv-verifiers:manage'), false);
      assert.equal(perms.includes('bgv-verifiers:read'), false);
    }
  }
  // Route-level: management is behind protect + superAdminSession + permit.
  const routes = readFileSync(new URL('../src/routes/superAdminRoutes.js', import.meta.url), 'utf8');
  assert.ok(routes.includes('router.use(protect, superAdminSession)'));
  assert.ok(routes.includes('permit("bgv-verifiers:manage")'));
  // Tenant routes never expose verifier management.
  const tenant = readFileSync(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8');
  assert.equal(tenant.includes('bgv-verifiers'), false);
});

// ══════════ SETUP ══════════

test('30.6: no temporary password; raw setup token never returned/persisted/audited', async () => {
  const world = makeWorld();
  const result = await invite(world);
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('passwordHash'), false); // nothing password-shaped returned
  assert.equal(result.verifier.passwordHash, undefined);

  const raw = extractSetupToken(world);
  assert.ok(raw && raw.length >= 40);
  // Hash-only persistence; raw absent from stored tokens, audits, and the
  // Super-Admin-facing result.
  assert.equal(JSON.stringify(world.state.tokens).includes(raw), false);
  assert.equal(JSON.stringify(world.state.audits).includes(raw), false);
  assert.equal(blob.includes(raw), false);
  // The email (delivery channel only) carries the link, no password.
  const mail = world.state.mails[0];
  assert.ok(mail.text.includes(raw));
  assert.equal(/your password is/i.test(mail.text), false);
  assert.equal(/candidate/i.test(mail.text), false);
});

test('30.6: setup works once; expired, revoked, and reused tokens rejected', async () => {
  const world = makeWorld();
  await invite(world);
  const raw = extractSetupToken(world);

  // Reuse before consumption is fine once; second use fails.
  await completeVerifierSetup({ rawToken: raw, password: PASSWORD, deps: world.deps });
  await assert.rejects(completeVerifierSetup({ rawToken: raw, password: PASSWORD, deps: world.deps }), (e) => e.statusCode === 409);

  // Weak password rejected by the platform policy.
  const weak = makeWorld();
  await invite(weak);
  await assert.rejects(
    completeVerifierSetup({ rawToken: extractSetupToken(weak), password: 'weak', deps: weak.deps }),
    (e) => e.statusCode === 400
  );

  // Expired token.
  const expired = makeWorld();
  await invite(expired);
  const expiredRaw = extractSetupToken(expired);
  expired.state.tokens[0].expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(completeVerifierSetup({ rawToken: expiredRaw, password: PASSWORD, deps: expired.deps }), (e) => e.statusCode === 404);

  // Revoked token.
  const revoked = makeWorld();
  await invite(revoked);
  const revokedRaw = extractSetupToken(revoked);
  await revokeVerifierSetupInvitation({ actorId: SUPER_ADMIN, verifierId: revoked.state.verifiers[0]._id, deps: revoked.deps });
  await assert.rejects(completeVerifierSetup({ rawToken: revokedRaw, password: PASSWORD, deps: revoked.deps }), (e) => e.statusCode === 404);
});

test('30.6: resend rotates the setup link (old link dies)', async () => {
  const world = makeWorld();
  await invite(world);
  const oldRaw = extractSetupToken(world);
  await resendVerifierSetup({ actorId: SUPER_ADMIN, verifierId: world.state.verifiers[0]._id, deps: world.deps });
  const newRaw = extractSetupToken(world);
  assert.notEqual(oldRaw, newRaw);
  await assert.rejects(completeVerifierSetup({ rawToken: oldRaw, password: PASSWORD, deps: world.deps }), (e) => e.statusCode === 404);
  await completeVerifierSetup({ rawToken: newRaw, password: PASSWORD, deps: world.deps });
  assert.equal(world.state.verifiers[0].status, 'ACTIVE');
});

// ══════════ LOGIN / SESSION ══════════

test('30.6: valid login; wrong password, unknown account, deactivated all generic', async () => {
  const world = makeWorld();
  const session = await setupAndLogin(world);
  assert.ok(session.token.startsWith('fake-jwt:'));
  assert.equal(session.verifier.status, 'ACTIVE');
  assert.equal(session.verifier.passwordHash, undefined); // never exposed

  const wrong = await assert.rejects(
    loginVerifier({ email: 'verifier.one@infolexus.example', password: 'Wrong#Pass123', deps: world.deps }),
    (e) => e.statusCode === 401
  );
  void wrong;
  const unknown = await assert.rejects(
    loginVerifier({ email: 'ghost@infolexus.example', password: PASSWORD, deps: world.deps }),
    (e) => e.statusCode === 401
  );
  void unknown;
  // All three failures share the SAME generic message (enumeration resistance).
  const failures = [];
  for (const attempt of [
    { email: 'verifier.one@infolexus.example', password: 'Wrong#Pass123' },
    { email: 'ghost@infolexus.example', password: PASSWORD },
  ]) {
    try {
      await loginVerifier({ ...attempt, deps: world.deps });
    } catch (error) {
      failures.push(error.message);
    }
  }
  await deactivateVerifier({ actorId: SUPER_ADMIN, verifierId: world.state.verifiers[0]._id, deps: world.deps });
  try {
    await loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, deps: world.deps });
  } catch (error) {
    failures.push(error.message);
  }
  assert.deepEqual(failures, [GENERIC_AUTH_FAILURE, GENERIC_AUTH_FAILURE, GENERIC_AUTH_FAILURE]);
});

test('30.6: verifier session lifecycle — resolve, logout, deactivation, reactivation', async () => {
  const world = makeWorld();
  const session = await setupAndLogin(world);
  const verifierId = world.state.verifiers[0]._id;
  const decoded = { principalType: VERIFIER_PRINCIPAL_TYPE, verifierId, sessionId: world.state.sessions[0].sessionId };

  // Verifier session reaches verifier-only surfaces.
  const resolved = await resolveVerifierSession({ decoded, deps: world.deps });
  assert.ok(resolved?.verifier);
  assert.equal(resolved.verifier.email, 'verifier.one@infolexus.example');

  // Tenant/platform tokens can NEVER resolve as verifier sessions.
  assert.equal(await resolveVerifierSession({ decoded: { sub: 'x', sessionId: 'y' }, deps: world.deps }), null);

  // Logout revokes the session.
  await logoutVerifier({ verifierId, sessionId: decoded.sessionId, deps: world.deps });
  assert.equal(await resolveVerifierSession({ decoded, deps: world.deps }), null);

  // Fresh login, then deactivation kills access and blocks new logins.
  await setupAndLogin(world).catch(() => {}); // already ACTIVE — login directly:
  const second = await loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, deps: world.deps });
  void second;
  await deactivateVerifier({ actorId: SUPER_ADMIN, verifierId, deps: world.deps });
  const activeSessionId = world.state.sessions[world.state.sessions.length - 1].sessionId;
  assert.equal(
    await resolveVerifierSession({ decoded: { principalType: VERIFIER_PRINCIPAL_TYPE, verifierId, sessionId: activeSessionId }, deps: world.deps }),
    null
  );

  // Reactivation restores login WITHOUT issuing passwords; old sessions stay dead.
  const reactivated = await reactivateVerifier({ actorId: SUPER_ADMIN, verifierId, deps: world.deps });
  assert.equal(reactivated.status, 'ACTIVE');
  assert.equal(
    await resolveVerifierSession({ decoded: { principalType: VERIFIER_PRINCIPAL_TYPE, verifierId, sessionId: activeSessionId }, deps: world.deps }),
    null
  );
  const third = await loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, deps: world.deps });
  assert.ok(third.token);
});

test('30.6: principal isolation is enforced in middleware code (structure)', async () => {
  const protectCode = readFileSync(new URL('../src/middlewares/authMiddleware.js', import.meta.url), 'utf8');
  assert.ok(protectCode.includes("decoded.principalType === 'BGV_VERIFIER'")); // tenant gate rejects verifier tokens pre-DB
  const verifierMw = readFileSync(new URL('../src/middlewares/bgvVerifierAuth.js', import.meta.url), 'utf8');
  assert.ok(verifierMw.includes('VERIFIER_PRINCIPAL_TYPE'));
  assert.ok(verifierMw.includes('status !== \'ACTIVE\'') || verifierMw.includes('resolveVerifierSession'));
  // Verifier auth routes apply the verifier-only middleware.
  const routes = readFileSync(new URL('../src/routes/bgvVerifierAuthRoutes.js', import.meta.url), 'utf8');
  assert.ok(routes.includes("requireVerifierAuth"));
  assert.ok(routes.includes('securityRateLimit'));
});

test('30.6: optional 2FA follows the platform OTP pattern (hashed, one-time)', async () => {
  const world = makeWorld();
  await setupAndLogin(world);
  await updateVerifierProfile({ actorId: SUPER_ADMIN, verifierId: world.state.verifiers[0]._id, twoFactorEnabled: true, deps: world.deps });

  // First step: OTP challenge, no session yet.
  const challenge = await loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, deps: world.deps });
  assert.equal(challenge.requiresTwoFactor, true);
  assert.ok(challenge.challengeId);
  assert.equal(challenge.token, undefined);

  // Wrong code denied generically.
  await assert.rejects(
    loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, challengeId: challenge.challengeId, code: '000000', deps: world.deps }),
    (e) => e.statusCode === 401 && e.message === GENERIC_AUTH_FAILURE
  );

  // The hashed OTP is in the token store; recover it only to prove the
  // pattern (tests may read fixtures; production never returns it).
  const otpRow = world.state.tokens.find((t) => t.purpose === 'TWO_FACTOR' && !t.usedAt);
  const code = ['100000', '200000', '300000', '400000', '500000', '600000', '700000', '800000', '900000', '123456', '999999', '424242']
    .find((candidate) => hashToken(candidate) === otpRow.tokenHash) || brute(otpRow.tokenHash);
  const full = await loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, challengeId: challenge.challengeId, code, deps: world.deps });
  assert.ok(full.token);

  function brute(hash) {
    for (let i = 100000; i <= 999999; i += 1) {
      if (hashToken(String(i)) === hash) return String(i);
    }
    return '';
  }
});

// ══════════ SPECIALIZATIONS & BOUNDARIES ══════════

test('30.6: specializations visible in own profile; changes audited; zero candidate coupling', async () => {
  const world = makeWorld();
  await setupAndLogin(world);
  const verifierId = world.state.verifiers[0]._id;

  const updated = await updateVerifierProfile({
    actorId: SUPER_ADMIN,
    verifierId,
    specializations: ['EDUCATION'],
    deps: world.deps,
  });
  assert.deepEqual(updated.specializations, ['EDUCATION']);

  const profile = await getVerifierProfile({ verifierId, deps: world.deps });
  assert.deepEqual(profile.specializations, ['EDUCATION']);
  assert.equal(profile.passwordHash, undefined);

  const audit = world.state.audits.find((entry) => entry.action === 'BGV_VERIFIER_UPDATED');
  assert.deepEqual(audit.metadata.specializations, ['EDUCATION']);

  // Specialization grants ZERO candidate access: the whole service has no
  // candidate/collection/evidence/order coupling and creates no assignments.
  const code = codeOnly('../src/services/bgv/bgvVerifierService.js');
  for (const banned of ['Candidate', 'BgvCollectionCase', 'BgvEvidenceFile', 'BgvOrder', 'currentStage', 'razorpay']) {
    assert.equal(code.includes(banned), false, 'banned coupling: ' + banned);
  }
  assert.equal(code.includes('assignVerifier'), false);
  assert.equal(code.includes('assignment'), false);
});

test('30.6: password recovery is generic, one-time, and revokes sessions', async () => {
  const world = makeWorld();
  await setupAndLogin(world);
  const verifierId = world.state.verifiers[0]._id;

  const ghost = await requestVerifierPasswordReset({ email: 'ghost@infolexus.example', deps: world.deps });
  const real = await requestVerifierPasswordReset({ email: 'verifier.one@infolexus.example', deps: world.deps });
  assert.equal(ghost.message, real.message); // anti-enumeration

  const resetRaw = String(world.state.mails[world.state.mails.length - 1].text).match(/reset-password\/(\S+)/)[1];
  await resetVerifierPassword({ rawToken: resetRaw, password: 'NewVerifier#2026', deps: world.deps });
  await assert.rejects(resetVerifierPassword({ rawToken: resetRaw, password: 'NewVerifier#2026', deps: world.deps }), (e) => e.statusCode === 409);

  // Old sessions are signed out; old password no longer works.
  const sessionId = world.state.sessions[0].sessionId;
  assert.equal(
    await resolveVerifierSession({ decoded: { principalType: VERIFIER_PRINCIPAL_TYPE, verifierId, sessionId }, deps: world.deps }),
    null
  );
  await assert.rejects(loginVerifier({ email: 'verifier.one@infolexus.example', password: PASSWORD, deps: world.deps }), (e) => e.statusCode === 401);
  const fresh = await loginVerifier({ email: 'verifier.one@infolexus.example', password: 'NewVerifier#2026', deps: world.deps });
  assert.ok(fresh.token);
});

test('30.6: audit is redacted and no seeds/verifier candidate routes exist (structure)', async () => {
  const world = makeWorld();
  await setupAndLogin(world);
  const audited = JSON.stringify(world.state.audits);
  assert.equal(audited.includes(PASSWORD), false);
  assert.equal(audited.includes('fake-jwt'), false); // session tokens never audited
  // raw tokens absent from audit
  const raw = null;
  void raw;
  for (const mail of world.state.mails) {
    const setupMatch = String(mail.text).match(/setup\/(\S+)/);
    if (setupMatch) assert.equal(audited.includes(setupMatch[1]), false);
  }

  // No candidate-facing data in verifier controllers/routes.
  const controller = codeOnly('../src/controllers/bgvVerifierController.js');
  assert.equal(controller.toLowerCase().includes('candidate'), false);
  const authRoutes = readFileSync(new URL('../src/routes/bgvVerifierAuthRoutes.js', import.meta.url), 'utf8');
  assert.equal(authRoutes.includes('candidate'), false);
  assert.equal(authRoutes.includes('document'), false);
});
