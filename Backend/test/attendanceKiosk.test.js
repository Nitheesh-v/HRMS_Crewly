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
  KIOSK_EMPLOYEE_CONTEXT_PURPOSE,
  KIOSK_EMPLOYEE_CONTEXT_TTL_MS,
  KIOSK_PIN_MAX_LENGTH,
  KIOSK_PIN_MIN_LENGTH,
  KIOSK_SESSION_TTL_MS,
  RESERVED_SOURCE,
  isMonthLockedForIngest,
  maskEmployeeName,
  normalizeDeviceEvent,
  validateIngestContext,
  validateKioskClaims,
  validateKioskEmployeeClaims,
  validateKioskPinShape,
} from '../src/services/attendance/attendanceSourceRules.js';
import {
  clearKioskPin,
  createStation,
  getKioskPinStatus,
  hashStationSecret,
  identifyEmployee,
  listStations,
  openSession,
  punchEmployee,
  rotateStationSecret,
  setKioskPin,
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
    [U_EMP, { _id: U_EMP, companyId: COMPANY, name: 'Asha Verma', employeeCode: 'EMP001', status: 'ACTIVE', role: 'EMPLOYEE', kioskPinHash: 'HASHED-1234', kioskPinVersion: 1, kioskPinSetAt: new Date('2026-09-01T00:00:00.000Z') }],
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
          if (filter._id && String(u._id) !== String(filter._id)) return false;
          if (filter.companyId && String(u.companyId) !== String(filter.companyId)) return false;
          if (filter.employeeCode && String(u.employeeCode).toUpperCase() !== String(filter.employeeCode).toUpperCase()) return false;
          if (filter.status && u.status !== filter.status) return false;
          return true;
        });
        return chain(user ? { ...user } : null);
      },
      findOneAndUpdate: (filter, update) => {
        const user = [...users.values()].find((u) => {
          if (filter._id && String(u._id) !== String(filter._id)) return false;
          if (filter.companyId && String(u.companyId) !== String(filter.companyId)) return false;
          return true;
        });
        if (!user) return chain(null);
        Object.assign(user, update.$set || {});
        if (update.$inc?.kioskPinVersion) user.kioskPinVersion += update.$inc.kioskPinVersion;
        return chain({ ...user });
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
    // Deterministic PIN hashing contract (mirrors the bcrypt seam:
    // hashPin output is the only input comparePin ever accepts).
    hashPin: async (pin) => `HASHED-${pin}`,
    comparePin: async (pin, hash) => hash === `HASHED-${pin}`,
    signEmployeeToken: (claims) => `emp.${claims.userId}.${claims.stationId}.${claims.pv}`,
    verifyEmployeeToken: (token) => {
      const [, userId, stationId, pv] = String(token).split('.');
      return {
        typ: 'kiosk-employee',
        companyId: COMPANY,
        stationId,
        userId,
        pv: Number(pv),
        purpose: KIOSK_EMPLOYEE_CONTEXT_PURPOSE,
      };
    },
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
  const result = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'emp001', pin: '1234', deps });
  assert.equal(result.employeeCode, 'EMP001');
  assert.equal(result.maskedName, 'Asha V.');
  assert.equal(result.liveState, 'NOT_IN');
  assert.deepEqual(result.allowedActions, ['CLOCK_IN']);
  assert.equal(result.name, undefined);
  assert.ok(result.employeeToken.startsWith('emp.'));
  assert.ok(Date.parse(result.expiresAt) > Date.now());
});

test('31.14 kiosk: identify is generic for unknown codes', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await assert.rejects(
    identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'NOPE', pin: '1234', deps }),
    (error) => error.statusCode === 401 && /Employee code or PIN is incorrect/.test(error.message)
  );
});

test('31.14 kiosk: punch converges on recordEvent with server-decided KIOSK ingest', async () => {
  const { deps, recorded } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', locationId: LOC, deps });
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  await punchEmployee({
    companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken, action: 'CLOCK_IN', deps,
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
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken, action: 'CLOCK_IN', deps }),
    /Reopen it through Attendance Finalization/
  );
});

// ── 31.14 completion: PIN rules ──────────────────────────────

test('31.14 completion: Kiosk PIN shape vocabulary', () => {
  assert.equal(KIOSK_PIN_MIN_LENGTH, 4);
  assert.equal(KIOSK_PIN_MAX_LENGTH, 12);
  assert.equal(validateKioskPinShape('1234'), null);
  assert.equal(validateKioskPinShape('123456789012'), null);
  assert.match(validateKioskPinShape(''), /required/);
  assert.match(validateKioskPinShape(null), /required/);
  assert.match(validateKioskPinShape('123'), /4–12/);
  assert.match(validateKioskPinShape('1234567890123'), /4–12/);
  assert.match(validateKioskPinShape('12a4'), /digits only/);
  assert.match(validateKioskPinShape(' 1234'), /digits only/);
});

test('31.14 completion: employee-context claim vocabulary', () => {
  assert.equal(KIOSK_EMPLOYEE_CONTEXT_TTL_MS, 3 * 60 * 1000);
  assert.equal(KIOSK_EMPLOYEE_CONTEXT_PURPOSE, 'kiosk-punch');
  const good = {
    typ: 'kiosk-employee',
    companyId: COMPANY,
    stationId: '400000000000000000000001',
    userId: U_EMP,
    pv: 1,
    purpose: 'kiosk-punch',
  };
  assert.deepEqual(validateKioskEmployeeClaims(good), []);
  assert.ok(validateKioskEmployeeClaims(null).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, typ: 'kiosk' }).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, typ: 'employee' }).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, companyId: 'nope' }).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, stationId: 'nope' }).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, userId: 'nope' }).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, purpose: 'kiosk-admin' }).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, pv: -1 }).length > 0);
  assert.ok(validateKioskEmployeeClaims({ ...good, pv: 1.5 }).length > 0);
});

// ── 31.14 completion: PIN lifecycle ──────────────────────────

test('31.14 completion: PIN status/set cycle in the employee session', async () => {
  const { deps } = buildWorld();
  const before = await getKioskPinStatus({ companyId: COMPANY, userId: U_EMP, deps });
  assert.deepEqual(before, { configured: true });
  await assert.rejects(
    getKioskPinStatus({ companyId: COMPANY, userId: '100000000000000000000099', deps }),
    /Employee not found/
  );
});

test('31.14 completion: first set needs no current PIN, then change requires it', async () => {
  const { deps, users } = buildWorld();
  users.get(U_EMP).kioskPinHash = null;
  users.get(U_EMP).kioskPinVersion = 0;
  const set = await setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '5678', actor: { _id: U_EMP }, deps });
  assert.deepEqual(set, { configured: true });
  assert.equal(users.get(U_EMP).kioskPinHash, 'HASHED-5678');
  assert.equal(users.get(U_EMP).kioskPinVersion, 1);
  assert.ok(users.get(U_EMP).kioskPinSetAt instanceof Date);

  await assert.rejects(
    setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '9999', deps }),
    /Current Kiosk PIN is required/
  );
  await assert.rejects(
    setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '9999', currentPin: '0000', deps }),
    (error) => error.statusCode === 401 && /Current Kiosk PIN is incorrect/.test(error.message)
  );
  const changed = await setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '9999', currentPin: '5678', deps });
  assert.deepEqual(changed, { configured: true });
  assert.equal(users.get(U_EMP).kioskPinVersion, 2);
});

test('31.14 completion: PIN set refuses bad shapes, inactive users, strangers', async () => {
  const { deps, users } = buildWorld();
  await assert.rejects(setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '12', deps }), /4–12/);
  await assert.rejects(
    setKioskPin({ companyId: COMPANY, userId: '100000000000000000000099', pin: '1234', deps }),
    /Employee not found/
  );
  users.get(U_EMP).status = 'INACTIVE';
  await assert.rejects(
    setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '1234', currentPin: '1234', deps }),
    (error) => error.statusCode === 403 && /Only active employees/.test(error.message)
  );
});

test('31.14 completion: HR clear forces fresh setup, never reveals the PIN', async () => {
  const { deps, users, audits } = buildWorld();
  const cleared = await clearKioskPin({ companyId: COMPANY, targetUserId: U_EMP, actor: { _id: '200000000000000000000001' }, deps });
  assert.deepEqual(cleared, { configured: false });
  assert.equal(users.get(U_EMP).kioskPinHash, null);
  assert.equal(users.get(U_EMP).kioskPinVersion, 2);
  await assert.rejects(
    clearKioskPin({ companyId: COMPANY, targetUserId: '100000000000000000000099', deps }),
    /Employee not found/
  );
  await assert.rejects(
    clearKioskPin({ companyId: COMPANY, targetUserId: 'nope', deps }),
    /targetUserId must be an ObjectId/
  );
  const pinAudit = audits.find((a) => a.action === 'ATTENDANCE_KIOSK_PIN_CLEARED');
  assert.ok(pinAudit);
  assert.equal(pinAudit.targetUserId, U_EMP);
});

test('31.14 completion: no PIN material ever reaches the audit trail', async () => {
  const { deps, users, audits } = buildWorld();
  users.get(U_EMP).kioskPinHash = null;
  await setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '5678', deps });
  await setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '9999', currentPin: '5678', deps });
  await clearKioskPin({ companyId: COMPANY, targetUserId: U_EMP, deps });
  const trail = JSON.stringify(audits);
  assert.ok(!trail.includes('5678'));
  assert.ok(!trail.includes('9999'));
  assert.ok(!trail.includes('HASHED'));
});

// ── 31.14 completion: identify matrix ────────────────────────

test('31.14 completion: wrong PIN fails exactly like an unknown code', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await assert.rejects(
    identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '0000', deps }),
    (error) => error.statusCode === 401 && /Employee code or PIN is incorrect/.test(error.message)
  );
});

test('31.14 completion: unset PIN and inactive employee fail generically', async () => {
  const { deps, users } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  users.get(U_EMP).kioskPinHash = null;
  await assert.rejects(
    identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps }),
    /Employee code or PIN is incorrect/
  );
  users.get(U_EMP).kioskPinHash = 'HASHED-1234';
  users.get(U_EMP).status = 'INACTIVE';
  await assert.rejects(
    identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps }),
    /Employee code or PIN is incorrect/
  );
});

test('31.14 completion: malformed PIN fails generically, never 400', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  for (const pin of ['abcd', '', null]) {
    await assert.rejects(
      identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin, deps }),
      (error) => error.statusCode === 401 && /Employee code or PIN is incorrect/.test(error.message)
    );
  }
});

test('31.14 completion: cross-tenant employees cannot be identified', async () => {
  const { deps, users } = buildWorld();
  users.set('100000000000000000000002', {
    _id: '100000000000000000000002', companyId: COMPANY_B, name: 'Bala Other', employeeCode: 'B999',
    status: 'ACTIVE', role: 'EMPLOYEE', kioskPinHash: 'HASHED-1111', kioskPinVersion: 1,
  });
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await assert.rejects(
    identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'B999', pin: '1111', deps }),
    /Employee code or PIN is incorrect/
  );
});

test('31.14 completion: identify returns exactly the safe shared-screen keys', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  const result = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  assert.deepEqual(
    Object.keys(result).sort(),
    ['allowedActions', 'employeeCode', 'employeeToken', 'expiresAt', 'liveState', 'maskedName']
  );
});

// ── 31.14 completion: punch trusts the context only ──────────

test('31.14 completion: forged, carried, and stale contexts are refused generically', async () => {
  const { deps } = buildWorld();
  const a = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  const b = await createStation({ companyId: COMPANY, name: 'Gate', deps });
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: a.station.id, employeeCode: 'EMP001', pin: '1234', deps });

  deps.verifyEmployeeToken = () => { throw new Error('bad signature'); };
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: a.station.id, employeeToken: 'emp.forged', action: 'CLOCK_IN', deps }),
    /invalid or expired/
  );
  delete deps.verifyEmployeeToken;

  // Carried to another station.
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: b.station.id, employeeToken: verified.employeeToken, action: 'CLOCK_IN', deps }),
    /invalid or expired/
  );
  // Carried to another tenant.
  await assert.rejects(
    punchEmployee({ companyId: COMPANY_B, stationId: a.station.id, employeeToken: verified.employeeToken, action: 'CLOCK_IN', deps }),
    /invalid or expired/
  );
  // Missing entirely.
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: a.station.id, employeeToken: '', action: 'CLOCK_IN', deps }),
    /invalid or expired/
  );
});

test('31.14 completion: wrong-purpose and version-stale contexts are refused', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  deps.verifyEmployeeToken = () => ({
    typ: 'kiosk-employee', companyId: COMPANY, stationId: station.id, userId: U_EMP, pv: 1, purpose: 'kiosk-admin',
  });
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: station.id, employeeToken: 'emp.x', action: 'CLOCK_IN', deps }),
    /invalid or expired/
  );
  // PIN rotated after the context was minted.
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  delete deps.verifyEmployeeToken;
  await setKioskPin({ companyId: COMPANY, userId: U_EMP, pin: '9999', currentPin: '1234', deps });
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken, action: 'CLOCK_IN', deps }),
    /invalid or expired/
  );
});

test('31.14 completion: deactivated employees cannot punch on old contexts', async () => {
  const { deps, users } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  users.get(U_EMP).status = 'INACTIVE';
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken, action: 'CLOCK_IN', deps }),
    /invalid or expired/
  );
});

test('31.14 completion: unknown actions still 400 before context checks', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  await assert.rejects(
    punchEmployee({ companyId: COMPANY, stationId: station.id, employeeToken: 'emp.x', action: 'NAPTIME', deps }),
    /Unknown attendance action/
  );
});

test('31.14 completion: break/out punches reuse the machine with null workMode', async () => {
  const { deps, recorded } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  await punchEmployee({
    companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken,
    action: 'BREAK_START', idempotencyKey: 'k1', deps,
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].action, 'BREAK_START');
  assert.equal(recorded[0].workMode, null);
  assert.equal(recorded[0].ingest.source, 'KIOSK');
  assert.equal(recorded[0].idempotencyKey, 'k1');
  assert.equal(recorded[0].ingest.provenance.stationName, 'Lobby');
});

// ── 31.14 completion: terminal GPS for strict policies ───────
// The terminal sends position ONLY when the gate demands it; the
// fence always comes from the station binding, never the client.

test('31.14 completion: punch forwards station fence + terminal GPS to recordEvent', async () => {
  const { deps, recorded } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', locationId: LOC, deps });
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  const position = { latitude: 10.7175, longitude: 77.0555, accuracy: 150 };
  await punchEmployee({
    companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken,
    action: 'CLOCK_IN', position, deps,
  });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].location, { locationId: LOC, position });
});

test('31.14 completion: punch without GPS still names the bound fence', async () => {
  const { deps, recorded } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', locationId: LOC, deps });
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  await punchEmployee({
    companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken, action: 'CLOCK_IN', deps,
  });
  assert.deepEqual(recorded[0].location, { locationId: LOC, position: null });
});

test('31.14 completion: GPS with an unbound station is refused honestly', async () => {
  const { deps } = buildWorld();
  const { station } = await createStation({ companyId: COMPANY, name: 'Lobby', deps });
  const verified = await identifyEmployee({ companyId: COMPANY, stationId: station.id, employeeCode: 'EMP001', pin: '1234', deps });
  const position = { latitude: 10.7175, longitude: 77.0555, accuracy: 150 };
  await assert.rejects(
    punchEmployee({
      companyId: COMPANY, stationId: station.id, employeeToken: verified.employeeToken,
      action: 'CLOCK_IN', position, deps,
    }),
    /not bound to a verifiable location/
  );
});

// ── Static integrity ─────────────────────────────────────────

test('31.14 kiosk: routes + middleware enforce the trust boundary', () => {
  const kioskRoutes = readSource('src/routes/attendance/attendanceKioskRoutes.js');
  assert.match(kioskRoutes, /kioskAuth/);
  assert.match(kioskRoutes, /securityRateLimit/);
  assert.match(kioskRoutes, /\/session/);
  assert.match(kioskRoutes, /\/identify/);
  assert.match(kioskRoutes, /\/punch/);
  // No employee-JWT middleware on the kiosk router, ever.
  assert.ok(!/protect/.test(kioskRoutes));

  const mainRoutes = readSource('src/routes/attendance/attendanceRoutes.js');
  assert.match(mainRoutes, /ATTENDANCE_CAPTURE_MANAGE/);
  assert.match(mainRoutes, /\/kiosks/);

  const auth = readSource('src/middlewares/kioskAuth.js');
  assert.match(auth, /typ.*kiosk|kiosk.*typ/);
  assert.match(auth, /secretVersion/);
  assert.match(auth, /req\.companyId = /);

  const registry = readSource('src/utils/permissionRegistry.js');
  assert.match(registry, /ATTENDANCE_CAPTURE/);
  const permService = readSource('src/utils/permissionService.js');
  assert.match(permService, /SYSTEM_PERMISSION_VERSION = 36/);
});

test('31.14 kiosk: punch path never reads source/provenance from the client', () => {
  const controller = readSource('src/controllers/attendance/attendanceKioskController.js');
  assert.ok(!/req\.body\.(source|provenance|ingest)/.test(controller));
  const validator = readSource('src/validators/attendance/attendanceCaptureValidator.js');
  assert.match(validator, /noSourceOverride/);
  assert.match(validator, /kioskPunchValidator/);
});

test('31.14 completion: punch identity comes only from the verified context', () => {
  const controller = readSource('src/controllers/attendance/attendanceKioskController.js');
  assert.match(controller, /const \{ employeeToken, action, idempotencyKey = null, position = null \} = req\.body/);
  assert.ok(!/employeeCode,\s*action/.test(controller));
  const validator = readSource('src/validators/attendance/attendanceCaptureValidator.js');
  assert.match(validator, /noKioskIdentityOverride/);
  assert.match(validator, /employeeToken/);
  assert.match(validator, /position\.latitude/);
  assert.ok(/kioskPunchValidator = \[[\s\S]*?body\('position'\)/.test(validator));
  assert.match(validator, /kioskPinSetValidator/);
  assert.match(validator, /kioskPinClearValidator/);
  const routes = readSource('src/routes/attendance/attendanceRoutes.js');
  assert.match(routes, /\/kiosk-pin/);
  assert.match(routes, /ATTENDANCE_CREATE_SELF/);
});

test('31.14 completion: PIN hash is select:false and never serialized', () => {
  const user = readSource('src/models/User.js');
  assert.match(user, /kioskPinHash:\s*\{\s*type:\s*String[^}]*select:\s*false/s);
  assert.match(user, /kioskPinVersion/);
  assert.match(user, /kioskPinSetAt/);
  const controller = readSource('src/controllers/attendance/attendanceKioskController.js');
  assert.ok(!/kioskPinHash/.test(controller));
  const service = readSource('src/services/attendance/attendanceKioskService.js');
  assert.ok(!/console\.log.*[Pp]in/.test(service));
});
