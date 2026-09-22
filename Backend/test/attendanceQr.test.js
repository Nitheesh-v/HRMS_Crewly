// ─────────────────────────────────────────────────────────────
// Phase 31.14 — QR challenge issuance, resolution, redemption.
//
// Hermetic: the QR service runs for REAL with every Mongo
// collaborator an in-memory fake (the atomic single-use claim is
// faithfully simulated); recordEvent/policy/live/audit are
// capturing stubs; the clock is fixed.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QR_CHALLENGE_TTL_MS,
  QR_PUNCH_PATH,
  QR_PURPOSE,
  QR_TOKEN_BYTES,
  QR_USE_REASON,
  buildQrPunchPath,
  hashQrToken,
  validateChallengeForUse,
} from '../src/services/attendance/attendanceQrRules.js';
import {
  createChallenge,
  redeemChallenge,
  resolveChallenge,
} from '../src/services/attendance/attendanceQrService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

const COMPANY = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const U_EMP = '100000000000000000000001';
const LOC = '300000000000000000000001';
const STATION = '400000000000000000000001';
const NOW = Date.parse('2026-09-16T09:00:00+05:30');

const chain = (result) => {
  const self = {
    select: () => self,
    populate: () => self,
    collation: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve(result),
  };
  return self;
};

const buildWorld = () => {
  const challenges = new Map();
  const audits = [];
  const recorded = [];
  let seq = 0;

  const ChallengeModel = {
    create: async (doc) => {
      seq += 1;
      const challenge = {
        _id: `5000000000000000000000${String(seq).padStart(2, '0')}`.slice(0, 24),
        ...doc,
        useCount: 0,
        usedAt: null,
        createdAt: new Date(NOW),
      };
      challenges.set(String(challenge._id), challenge);
      return { ...challenge, toObject: () => ({ ...challenge }) };
    },
    findOne: (filter = {}) => {
      const found = [...challenges.values()].find((c) => {
        if (filter.tokenHash && c.tokenHash !== filter.tokenHash) return false;
        return true;
      });
      if (!found) return chain(null);
      return chain({
        ...found,
        location: found.location ? { _id: found.location, name: 'HQ Lobby' } : null,
        station: found.station ? { _id: found.station, name: 'Lobby Kiosk' } : null,
      });
    },
    // Faithful atomic claim: the filter decides the winner.
    findOneAndUpdate: (filter, update) => {
      const found = [...challenges.values()].find((c) => {
        if (filter.tokenHash && c.tokenHash !== filter.tokenHash) return false;
        if (filter.companyId && String(c.companyId) !== String(filter.companyId)) return false;
        if (filter.purpose && c.purpose !== filter.purpose) return false;
        if (filter.expiresAt?.$gt && !(c.expiresAt > filter.expiresAt.$gt)) return false;
        if (filter.usedAt === null && c.usedAt !== null) return false;
        return true;
      });
      if (!found) return chain(null);
      Object.assign(found, update.$set || {});
      found.useCount += update.$inc?.useCount || 0;
      return chain({ ...found });
    },
    findById: (id) => {
      const found = challenges.get(String(id));
      if (!found) return chain(null);
      return chain({
        ...found,
        location: found.location ? { _id: found.location, name: 'HQ Lobby' } : null,
        station: found.station ? { _id: found.station, name: 'Lobby Kiosk' } : null,
      });
    },
  };

  const deps = {
    ChallengeModel,
    LocationModel: {
      findOne: (filter = {}) => chain(
        String(filter._id) === LOC && String(filter.companyId) === COMPANY
          ? { _id: LOC, name: 'HQ Lobby' }
          : null
      ),
    },
    StationModel: {
      findOne: (filter = {}) => chain(
        String(filter._id) === STATION && String(filter.companyId) === COMPANY
          ? { _id: STATION, name: 'Lobby Kiosk' }
          : null
      ),
    },
    UserModel: {
      findOne: (filter = {}) => chain(
        String(filter._id) === U_EMP && String(filter.companyId) === COMPANY && filter.status === 'ACTIVE'
          ? { _id: U_EMP, companyId: COMPANY, name: 'Asha Verma', employeeCode: 'EMP001', status: 'ACTIVE' }
          : null
      ),
    },
    PeriodModel: { findOne: () => chain(null) },
    getLiveAttendance: async () => ({ liveState: 'NOT_IN', allowedActions: ['CLOCK_IN'] }),
    recordEvent: async (args) => {
      recorded.push(args);
      return { event: { id: 'evt1', source: args.ingest?.source }, replayed: false };
    },
    getCurrentPolicy: async () => ({ policy: { timezone: 'Asia/Kolkata' } }),
    generateQrToken: async () => 'fixed-test-token-AAAAAAAAAAAAAAAAAAAAAAAA',
    now: () => NOW,
    audit: async (payload) => { audits.push(payload); return null; },
  };

  return { deps, audits, recorded, challenges };
};

// ── Pure QR rules ────────────────────────────────────────────

test('31.14 QR rules: five-minute single-purpose vocabulary', () => {
  assert.equal(QR_CHALLENGE_TTL_MS, 5 * 60 * 1000);
  assert.equal(QR_TOKEN_BYTES, 32);
  assert.equal(QR_PURPOSE, 'ATTENDANCE_PUNCH');
  assert.equal(QR_PUNCH_PATH, '/app/attendance/qr');
  assert.equal(buildQrPunchPath('tok'), '/app/attendance/qr/tok');
});

test('31.14 QR rules: tokens hash to sha256, empty hashes to empty', () => {
  const digest = hashQrToken('abc');
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(digest.length, 64);
  assert.equal(hashQrToken(''), '');
  assert.equal(hashQrToken(null), '');
});

test('31.14 QR rules: eligibility matrix', () => {
  const base = {
    companyId: COMPANY,
    purpose: QR_PURPOSE,
    expiresAt: new Date(NOW + 60_000),
    usedAt: null,
  };
  assert.deepEqual(validateChallengeForUse({ challenge: base, companyId: COMPANY, nowMs: NOW }), { valid: true, reason: null });
  assert.equal(validateChallengeForUse({ challenge: null, companyId: COMPANY, nowMs: NOW }).reason, QR_USE_REASON.NOT_FOUND);
  assert.equal(
    validateChallengeForUse({ challenge: base, companyId: COMPANY_B, nowMs: NOW }).reason,
    QR_USE_REASON.WRONG_TENANT
  );
  assert.equal(
    validateChallengeForUse({ challenge: { ...base, purpose: 'DOOR_UNLOCK' }, companyId: COMPANY, nowMs: NOW }).reason,
    QR_USE_REASON.WRONG_PURPOSE
  );
  assert.equal(
    validateChallengeForUse({ challenge: { ...base, expiresAt: new Date(NOW) }, companyId: COMPANY, nowMs: NOW }).reason,
    QR_USE_REASON.EXPIRED
  );
  assert.equal(
    validateChallengeForUse({ challenge: { ...base, usedAt: new Date(NOW - 1) }, companyId: COMPANY, nowMs: NOW }).reason,
    QR_USE_REASON.ALREADY_USED
  );
});

// ── Issuance ─────────────────────────────────────────────────

test('31.14 QR: issuance binds a place, hashes the token, expires in 5 minutes', async () => {
  const { deps, audits, challenges } = buildWorld();
  const result = await createChallenge({
    companyId: COMPANY, locationId: LOC, stationId: STATION, actor: { _id: U_EMP }, deps,
  });
  assert.equal(result.token, 'fixed-test-token-AAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(result.punchPath, '/app/attendance/qr/fixed-test-token-AAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(result.challenge.locationName, 'HQ Lobby');
  assert.equal(result.challenge.stationName, 'Lobby Kiosk');
  assert.equal(Date.parse(result.expiresAt), NOW + QR_CHALLENGE_TTL_MS);
  const stored = challenges.get(result.challenge.id);
  assert.equal(stored.tokenHash, hashQrToken(result.token));
  assert.ok(!('token' in stored));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'ATTENDANCE_QR_CHALLENGE_CREATED');
  assert.ok(!JSON.stringify(audits[0]).includes(result.token));
});

test('31.14 QR: issuance requires a location or a station', async () => {
  const { deps } = buildWorld();
  await assert.rejects(createChallenge({ companyId: COMPANY, deps }), /location or a station/);
  await assert.rejects(
    createChallenge({ companyId: COMPANY, locationId: '300000000000000000000099', deps }),
    /not found or inactive/
  );
});

// ── Resolution (never consumes) ──────────────────────────────

test('31.14 QR: resolve previews without consuming', async () => {
  const { deps, challenges } = buildWorld();
  const issued = await createChallenge({ companyId: COMPANY, locationId: LOC, deps });
  const preview = await resolveChallenge({ companyId: COMPANY, token: issued.token, userId: U_EMP, deps });
  assert.equal(preview.locationName, 'HQ Lobby');
  assert.equal(preview.allowedActions.join(','), 'CLOCK_IN');
  assert.equal(challenges.get(issued.challenge.id).usedAt, null);
  // Still redeemable afterwards.
  await redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_IN', deps });
  assert.ok(challenges.get(issued.challenge.id).usedAt instanceof Date);
});

test('31.14 QR: resolve errors are honest (410 gone, 404 cross-tenant)', async () => {
  const { deps } = buildWorld();
  const issued = await createChallenge({ companyId: COMPANY, locationId: LOC, deps });

  const expired = await createChallenge({ companyId: COMPANY, locationId: LOC, deps });
  deps.now = () => NOW + QR_CHALLENGE_TTL_MS + 1;
  await assert.rejects(
    resolveChallenge({ companyId: COMPANY, token: expired.token, userId: U_EMP, deps }),
    (error) => error.statusCode === 410
  );
  deps.now = () => NOW;

  await assert.rejects(
    resolveChallenge({ companyId: COMPANY_B, token: issued.token, userId: U_EMP, deps }),
    (error) => error.statusCode === 404
  );
  await assert.rejects(
    resolveChallenge({ companyId: COMPANY, token: 'never-issued', userId: U_EMP, deps }),
    /not recognized/
  );
});

// ── Redemption (single-use) ──────────────────────────────────

test('31.14 QR: redeem consumes once and punches through recordEvent', async () => {
  const { deps, recorded } = buildWorld();
  const issued = await createChallenge({ companyId: COMPANY, locationId: LOC, stationId: STATION, deps });
  await redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_IN', deps });
  assert.equal(recorded.length, 1);
  const call = recorded[0];
  assert.equal(String(call.userId), U_EMP);
  assert.equal(call.workMode, 'OFFICE');
  assert.equal(call.ingest.source, 'QR');
  assert.equal(call.ingest.provenance.challengeId, issued.challenge.id);
  assert.equal(call.ingest.provenance.locationName, 'HQ Lobby');
  assert.equal(call.ingest.provenance.stationName, 'Lobby Kiosk');

  await assert.rejects(
    redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_OUT', deps }),
    (error) => error.statusCode === 410
  );
  assert.equal(recorded.length, 1);
});

test('31.14 QR: redeem refuses finalized months', async () => {
  const { deps } = buildWorld();
  deps.PeriodModel = { findOne: () => chain({ status: 'FINALIZED' }) };
  const issued = await createChallenge({ companyId: COMPANY, locationId: LOC, deps });
  await assert.rejects(
    redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_IN', deps }),
    /Reopen it through Attendance Finalization/
  );
});

// ── 31.16 D-08: redeem carries GPS to the geofence gate ───────
// A location-bound challenge supplies its own locationId; the client
// contributes only its one-shot position. Without this pairing the
// 31.3 REQUIRED gate refused every QR clock-in.

test('31.16 D-08: redeem forwards challenge location + client position to recordEvent', async () => {
  const { deps, recorded } = buildWorld();
  const issued = await createChallenge({ companyId: COMPANY, locationId: LOC, stationId: STATION, deps });
  const position = { latitude: 10.7175, longitude: 77.0555, accuracy: 150 };
  await redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_IN', position, deps });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].location, { locationId: LOC, position });
});

test('31.16 D-08: redeem without GPS still names the bound fence (gate decides)', async () => {
  const { deps, recorded } = buildWorld();
  const issued = await createChallenge({ companyId: COMPANY, locationId: LOC, deps });
  await redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_IN', deps });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].location, { locationId: LOC, position: null });
});

test('31.16 D-08: station-only challenge resolves the bound station location', async () => {
  const { deps, recorded } = buildWorld();
  deps.StationModel = {
    findOne: () => chain({ _id: STATION, name: 'Lobby Kiosk', location: LOC }),
  };
  const issued = await createChallenge({ companyId: COMPANY, stationId: STATION, deps });
  const position = { latitude: 10.7175, longitude: 77.0555, accuracy: 150 };
  await redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_IN', position, deps });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].location, { locationId: LOC, position });
});

test('31.16 D-08: GPS with no verifiable binding is refused honestly', async () => {
  const { deps } = buildWorld();
  const issued = await createChallenge({ companyId: COMPANY, stationId: STATION, deps });
  const position = { latitude: 10.7175, longitude: 77.0555, accuracy: 150 };
  await assert.rejects(
    redeemChallenge({ companyId: COMPANY, userId: U_EMP, token: issued.token, action: 'CLOCK_IN', position, deps }),
    /not bound to a verifiable location/
  );
});

test('31.16 D-08: client locationId never reaches redeem (server decides)', async () => {
  const validator = readSource('src/validators/attendance/attendanceCaptureValidator.js');
  assert.match(validator, /noQrLocationOverride/);
  const controller = readSource('src/controllers/attendance/attendanceQrController.js');
  assert.ok(!/req\.body\.locationId/.test(controller));
});

// ── Static integrity ─────────────────────────────────────────

test('31.14 QR: POST-only routes, no GET punch path', () => {
  const routes = readSource('src/routes/attendance/attendanceRoutes.js');
  assert.match(routes, /\.post\(\s*'\/qr\/challenges'/);
  assert.match(routes, /\.post\(\s*'\/qr\/resolve'/);
  assert.match(routes, /\.post\(\s*'\/qr\/redeem'/);
  assert.ok(!/\.get\(\s*'\/qr\//.test(routes));

  const controller = readSource('src/controllers/attendance/attendanceQrController.js');
  assert.ok(!/req\.body\.(source|provenance|ingest)/.test(controller));
  assert.ok(!/req\.query\.token/.test(controller));
  const validator = readSource('src/validators/attendance/attendanceCaptureValidator.js');
  assert.match(validator, /qrRedeemValidator/);
});
