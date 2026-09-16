// ─────────────────────────────────────────────────────────────
// Phase 31.14 — kiosk stations, sessions, and punches.
//
// Hermetic: the kiosk service runs for REAL with every Mongo
// collaborator an in-memory fake; recordEvent/getLiveAttendance/
// policy/audit are capturing stubs. Pure source rules (ingest
// validation, finalized-month guard, kiosk claims, masking, the
// DEVICE adapter contract) are tested directly.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEVICE_EVENT_CONTRACT_KEYS,
  INGESTIBLE_SOURCE,
  INGEST_LOCKED_MONTH_STATUS,
  KIOSK_SESSION_TTL_MS,
  RESERVED_SOURCE,
  isMonthLockedForIngest,
  maskEmployeeName,
  normalizeDeviceEvent,
  validateIngestContext,
  validateKioskClaims,
} from '../src/services/attendance/attendanceSourceRules.js';
import {
  createStation,
  hashStationSecret,
  identifyEmployee,
  listStations,
  openSession,
  punchEmployee,
  rotateStationSecret,
  updateStation,
} from '../src/services/attendance/attendanceKioskService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

const COMPANY = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const U_EMP = '100000000000000000000001';
const LOC = '300000000000000000000001';

// ── Fakes ────────────────────────────────────────────────────

// Chainable Mongoose query fake: every intermediate returns the
// chain, .lean() resolves the canned result.
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
  const stations = new Map();
  const locations = new Map([
    [LOC, { _id: LOC, companyId: COMPANY, name: 'HQ Lobby', isActive: true }],
  ]);
  const users = new Map([
    [U_EMP, { _id: U_EMP, companyId: COMPANY, name: 'Asha Verma', employeeCode: 'EMP001', status: 'ACTIVE', role: 'EMPLOYEE' }],
  ]);
  const audits = [];
  const recorded = [];
  const live = { liveState: 'NOT_IN', allowedActions: ['CLOCK_IN'] };
  let seq = 0;

  const StationModel = {
    create: async (doc) => {
      for (const existing of stations.values()) {
        if (String(existing.companyId) === String(doc.companyId) && existing.name === doc.name) {
          const error = new Error('duplicate');
          error.code = 11000;
          throw error;
        }
      }
      seq += 1;
      const station = {
        _id: `4000000000000000000000${String(seq).padStart(2, '0')}`.slice(0, 24),
        ...doc,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      stations.set(String(station._id), station);
      return { ...station, toObject: () => ({ ...station }) };
    },
    find: (filter = {}) => {
      const rows = [...stations.values()]
        .filter((s) => !filter.companyId || String(s.companyId) === String(filter.companyId))
        .map((s) => ({ ...s, location: s.location ? locations.get(String(s.location)) || null : null }));
      return chain(rows);
    },
    findOne: (filter = {}) => {
      const station = [...stations.values()].find((s) => {
        if (filter._id && String(s._id) !== String(filter._id)) return false;
        if (filter.companyId && String(s.companyId) !== String(filter.companyId)) return false;
        if (filter.status && s.status !== filter.status) return false;
        return true;
      });
      if (!station) return chain(null);
      const copy = { ...station };
      if (copy.location && locations.get(String(copy.location))) {
        copy.location = { ...locations.get(String(copy.location)) };
      }
      return chain(copy);
    },
    findOneAndUpdate: (filter, update) => {
      const key = [...stations.keys()].find((id) => {
        const s = stations.get(id);
        if (filter._id && String(s._id) !== String(filter._id)) return false;
        if (filter.companyId && String(s.companyId) !== String(filter.companyId)) return false;
        return true;
      });
      if (!key) return chain(null);
      const station = stations.get(key);
      Object.assign(station, update.$set || {});
      if (update.$inc?.secretVersion) station.secretVersion += update.$inc.secretVersion;
      const copy = { ...station };
      if (copy.location && locations.get(String(copy.location))) {
        copy.location = { ...locations.get(String(copy.location)) };
      }
      return chain(copy);
    },
    updateOne: async () => ({ modifiedCount: 1 }),
  };

  const deps = {
    StationModel,
    LocationModel: {
      findOne: (filter = {}) => {
        const location = [...locations.values()].find((l) => {
          if (filter._id && String(l._id) !== String(filter._id)) return false;
          if (filter.companyId && String(l.companyId) !== String(filter.companyId)) return false;
          if (filter.isActive !== undefined && l.isActive !== filter.isActive) return false;
          return true;
        });
        return chain(location ? { ...location } : null);
      },
    },
    UserModel: {
      findOne: (filter = {}) => {
        const user = [...users.values()].find((u) => {
          if (filter.companyId && String(u.companyId) !== String(filter.companyId)) return false;
          if (filter.employeeCode && String(u.employeeCode).toUpperCase() !== String(filter.employeeCode).toUpperCase()) return false;
          if (filter.status && u.status !== filter.status) return false;
          return true;
        });
        return chain(user ? { ...user } : null);
      },
    },
    PeriodModel: { findOne: () => chain(null) },
    getLiveAttendance: async () => ({ ...live }),
    recordEvent: async (args) => {
      recorded.push(args);
      return { event: { id: 'evt1', source: args.ingest?.source }, replayed: false };
    },
    getCurrentPolicy: async () => ({ policy: { timezone: 'Asia/Kolkata' } }),
    signKioskToken: (claims) => `kiosk.${claims.stationId}.${claims.sv}`,
    audit: async (payload) => { audits.push(payload); return null; },
  };

  return { deps, audits, recorded, stations, users, live };
};

// ── Pure source rules ────────────────────────────────────────

test('31.14 source rules: ingestible vs reserved partition', () => {
  assert.deepEqual({ ...INGESTIBLE_SOURCE }, { KIOSK: 'KIOSK', QR: 'QR', IMPORT: 'IMPORT' });
  assert.deepEqual({ ...RESERVED_SOURCE }, { DEVICE: 'DEVICE', MANUAL: 'MANUAL' });
});

test('31.14 source rules: ingest validation accepts the three adapters, rejects the rest', () => {
  assert.deepEqual(validateIngestContext(null), []);
  const kiosk = { source: 'KIOSK', provenance: { stationId: '400000000000000000000001' } };
  assert.deepEqual(validateIngestContext(kiosk), []);
  assert.deepEqual(
    validateIngestContext({ source: 'QR', provenance: { challengeId: '500000000000000000000001' } }),
    []
  );
  assert.deepEqual(
    validateIngestContext({ source: 'IMPORT', provenance: { importBatchId: '600000000000000000000001' } }),
    []
  );
  assert.ok(validateIngestContext({ source: 'WEB', provenance: {} }).length > 0);
  assert.ok(validateIngestContext({ source: 'DEVICE', provenance: {} }).length > 0);
  assert.ok(validateIngestContext({ source: 'MANUAL', provenance: {} }).length > 0);
  assert.ok(validateIngestContext({ source: 'KIOSK', provenance: {} }).length > 0);
  assert.ok(validateIngestContext({ source: 'KIOSK', provenance: { stationId: 'not-an-id' } }).length > 0);
  assert.ok(validateIngestContext({ source: 'NOPE', provenance: {} }).length > 0);
});

test('31.14 source rules: finalized-month guard truth table', () => {
  assert.deepEqual([...INGEST_LOCKED_MONTH_STATUS], ['FINALIZING', 'FINALIZED', 'SENT_TO_PAYROLL']);
  assert.equal(isMonthLockedForIngest('FINALIZING'), true);
  assert.equal(isMonthLockedForIngest('FINALIZED'), true);
  assert.equal(isMonthLockedForIngest('SENT_TO_PAYROLL'), true);
  assert.equal(isMonthLockedForIngest('OPEN'), false);
  assert.equal(isMonthLockedForIngest('REOPENED'), false);
  assert.equal(isMonthLockedForIngest(null), false);
  assert.equal(isMonthLockedForIngest(undefined), false);
});

test('31.14 source rules: kiosk claims accept kiosk JWTs, reject employee JWTs', () => {
  const good = { typ: 'kiosk', stationId: '400000000000000000000001', companyId: COMPANY, sv: 1 };
  assert.deepEqual(validateKioskClaims(good), []);
  // Employee session tokens have no kiosk claims — rejected.
  assert.ok(validateKioskClaims({ id: U_EMP, role: 'EMPLOYEE', companyId: COMPANY }).length > 0);
  assert.ok(validateKioskClaims({ ...good, typ: 'user' }).length > 0);
  assert.ok(validateKioskClaims({ ...good, stationId: 'bad' }).length > 0);
  assert.ok(validateKioskClaims({ ...good, sv: 0 }).length > 0);
  assert.ok(validateKioskClaims(null).length > 0);
});

test('31.14 source rules: name masking shows first name + last initial only', () => {
  assert.equal(maskEmployeeName('Asha Verma'), 'Asha V.');
  assert.equal(maskEmployeeName('Al'), 'Al');
  assert.equal(maskEmployeeName(''), '');
  assert.equal(maskEmployeeName(null), '');
  assert.equal(maskEmployeeName('Asha Devi Verma'), 'Asha V.');
});

test('31.14 DEVICE contract: pinned shape, zero vendors', () => {
  const contract = readSource('src/services/attendance/attendanceSourceRules.js');
  assert.ok(!/zkteco|biomax|suprema|fingertec|realtime.*sdk|vendor.*sdk/i.test(contract));
  assert.deepEqual([...DEVICE_EVENT_CONTRACT_KEYS], [
    'employeeExternalRef',
    'timestamp',
    'eventType',
    'sourceReference',
    'deviceReference',
  ]);
  const good = {
    employeeExternalRef: 'ext-1',
    timestamp: '2026-09-16T09:00:00+05:30',
    eventType: 'CLOCK_IN',
    sourceReference: 'dev-1:evt-9',
    deviceReference: 'gate-2',
  };
  const ok = normalizeDeviceEvent(good);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.normalized, good);
  assert.equal(normalizeDeviceEvent(null).valid, false);
  assert.equal(normalizeDeviceEvent({ ...good, vendorSecret: 'x' }).valid, false);
  assert.equal(normalizeDeviceEvent({ ...good, timestamp: '' }).valid, false);
  assert.equal(normalizeDeviceEvent({ ...good, deviceReference: 'x'.repeat(200) }).valid, false);
});

// ── Station lifecycle ────────────────────────────────────────

test('31.14 kiosk: create returns the secret once, stores only its hash', async () => {
  const { deps, audits, stations } = buildWorld();
  const { station, secret } = await createStation({
    companyId: COMPANY, name: 'Lobby Kiosk', locationId: LOC, actor: { _id: U_EMP }, deps,
  });
  assert.ok(secret.length >= 40);
  assert.equal(station.name, 'Lobby Kiosk');
  assert.equal(station.locationName, 'HQ Lobby');
  assert.equal(station.secretVersion, 1);
  assert.equal(station.secret, undefined);
  assert.equal(station.secretHash, undefined);
  const stored = stations.get(station.id);
  assert.equal(stored.secretHash, hashStationSecret(secret));
  assert.ok(!('secret' in stored));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'ATTENDANCE_KIOSK_CREATED');
  assert.ok(!JSON.stringify(audits[0]).includes(secret));
});

test('31.14 kiosk: station names are unique per tenant, reusable across tenants', async () => {
  const { deps } = buildWorld();
  await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await assert.rejects(
    createStation({ companyId: COMPANY, name: 'Lobby', deps }),
    /already exists/
  );
  const other = await createStation({ companyId: COMPANY_B, name: 'Lobby', deps });
  assert.equal(other.station.companyId, COMPANY_B);
});

test('31.14 kiosk: unknown locations are refused', async () => {
  const { deps } = buildWorld();
  await assert.rejects(
    createStation({ companyId: COMPANY, name: 'Lobby', locationId: '300000000000000000000099', deps }),
    /not found or inactive/
  );
});

test('31.14 kiosk: list/update/rotate stay tenant-scoped and audited', async () => {
  const { deps, audits } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await createStation({ companyId: COMPANY_B, name: 'Remote', deps });
  const rows = await listStations({ companyId: COMPANY, deps });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Lobby');

  const renamed = await updateStation({
    companyId: COMPANY, stationId: station.id, patch: { name: 'Lobby 2' }, deps,
  });
  assert.equal(renamed.name, 'Lobby 2');
  await assert.rejects(
    updateStation({ companyId: COMPANY_B, stationId: station.id, patch: { name: 'Hijack' }, deps }),
    /not found/i
  );

  const rotated = await rotateStationSecret({ companyId: COMPANY, stationId: station.id, deps });
  assert.ok(rotated.secret.length >= 40);
  assert.equal(rotated.secretVersion, 2);
  const actions = audits.map((a) => a.action);
  assert.ok(actions.includes('ATTENDANCE_KIOSK_UPDATED'));
  assert.ok(actions.includes('ATTENDANCE_KIOSK_SECRET_ROTATED'));
});

// ── Sessions ─────────────────────────────────────────────────

test('31.14 kiosk: session opens with the secret, fails generic without it', async () => {
  const { deps } = buildWorld();
  const { station, secret } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  const session = await openSession({ stationId: station.id, secret, deps });
  assert.ok(session.token.startsWith('kiosk.'));
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  assert.equal(session.station.name, 'Lobby');

  await assert.rejects(openSession({ stationId: station.id, secret: 'wrong', deps }), /Invalid station credentials/);
  await assert.rejects(
    openSession({ stationId: '400000000000000000000099', secret, deps }),
    /Invalid station credentials/
  );
});

test('31.14 kiosk: deactivated stations fail exactly like wrong secrets', async () => {
  const { deps } = buildWorld();
  const { station, secret } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await updateStation({ companyId: COMPANY, stationId: station.id, patch: { status: 'INACTIVE' }, deps });
  await assert.rejects(
    openSession({ stationId: station.id, secret, deps }),
    /Invalid station credentials/
  );
});

// ── Identify + punch ─────────────────────────────────────────

test('31.14 kiosk: identify masks the name and returns backend-derived actions', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  const result = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'emp001', deps });
  assert.equal(result.employeeCode, 'EMP001');
  assert.equal(result.maskedName, 'Asha V.');
  assert.equal(result.liveState, 'NOT_IN');
  assert.deepEqual(result.allowedActions, ['CLOCK_IN']);
  assert.equal(result.name, undefined);
});

test('31.14 kiosk: identify is generic for unknown codes', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await assert.rejects(
    identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'NOPE', deps }),
    /not found or inactive/
  );
});

test('31.14 kiosk: punch converges on recordEvent with server-decided KIOSK ingest', async () => {
  const { deps, recorded } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', locationId: LOC, deps });
  await punchEmployee({
    companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', action: 'CLOCK_IN', deps,
  });
  assert.equal(recorded.length, 1);
  const call = recorded[0];
  assert.equal(String(call.companyId), COMPANY);
  assert.equal(String(call.userId), U_EMP);
  assert.equal(call.action, 'CLOCK_IN');
  assert.equal(call.workMode, 'OFFICE');
  assert.equal(call.ingest.source, 'KIOSK');
  assert.equal(call.ingest.provenance.stationId, station.id);
  assert.equal(call.ingest.provenance.stationName, 'Lobby');
  assert.equal(call.ingest.provenance.locationName, 'HQ Lobby');
});

test('31.14 kiosk: punch refuses finalized months with reopen guidance', async () => {
  const { deps } = buildWorld();
  deps.PeriodModel = { findOne: () => chain({ status: 'FINALIZED' }) };
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', action: 'CLOCK_IN', deps }),
    /Reopen it through Attendance Finalization/
  );
});

// ── Static integrity ─────────────────────────────────────────

test('31.14 kiosk: routes + middleware enforce the trust boundary', () => {
  const kioskRoutes = readSource('src/routes/attendanceKioskRoutes.js');
  assert.match(kioskRoutes, /kioskAuth/);
  assert.match(kioskRoutes, /securityRateLimit/);
  assert.match(kioskRoutes, /\/session/);
  assert.match(kioskRoutes, /\/identify/);
  assert.match(kioskRoutes, /\/punch/);
  // No employee-JWT middleware on the kiosk router, ever.
  assert.ok(!/protect/.test(kioskRoutes));

  const mainRoutes = readSource('src/routes/attendanceRoutes.js');
  assert.match(mainRoutes, /ATTENDANCE_CAPTURE_MANAGE/);
  assert.match(mainRoutes, /\/kiosks/);

  const auth = readSource('src/middlewares/kioskAuth.js');
  assert.match(auth, /typ.*kiosk|kiosk.*typ/);
  assert.match(auth, /secretVersion/);
  assert.match(auth, /req\.companyId = /);

  const registry = readSource('src/utils/permissionRegistry.js');
  assert.match(registry, /ATTENDANCE_CAPTURE/);
  const permService = readSource('src/utils/permissionService.js');
  assert.match(permService, /SYSTEM_PERMISSION_VERSION = 35/);
});

test('31.14 kiosk: punch path never reads source/provenance from the client', () => {
  const controller = readSource('src/controllers/attendanceKioskController.js');
  assert.ok(!/req\.body\.(source|provenance|ingest)/.test(controller));
  const validator = readSource('src/validators/attendanceCaptureValidator.js');
  assert.match(validator, /noSourceOverride/);
  assert.match(validator, /kioskPunchValidator/);
});
