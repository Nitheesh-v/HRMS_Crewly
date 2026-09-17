// Phase 31.3 — Office Locations & Geofenced Attendance (hermetic suite).
//
// No MongoDB, no Redis, no network: models/policy/engine/clock are
// injected fakes; the REAL location rules, location service (CRUD +
// geofence gate), event service (CLOCK_IN integration), validators and
// permission registry run against them.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const LOC_OFFICE = 'ccccccccccccccccccccccc1';
const LOC_REMOTE = 'ccccccccccccccccccccccc2';

const [locationRules, locationService, eventService, policyRules, eventValidator, registry] =
  await Promise.all([
    import('../src/services/attendance/attendanceLocationRules.js'),
    import('../src/services/attendance/attendanceLocationService.js'),
    import('../src/services/attendance/attendanceEventService.js'),
    import('../src/services/attendance/attendancePolicyRules.js'),
    import('../src/validators/attendanceEventValidator.js'),
    import('../src/utils/permissionRegistry.js'),
  ]);

const {
  validateLatitude,
  validateLongitude,
  validateRadiusMeters,
  validateAccuracyMeters,
  isAccuracyUsable,
  validateLocationInput,
  haversineMeters,
  isInsideGeofence,
  geofenceRequirement,
  buildVerificationSnapshot,
} = locationRules;
const {
  listLocations,
  getLocation,
  createLocation,
  updateLocation,
  setLocationActive,
  listEligibleLocations,
} = locationService;
const { recordEvent, getLiveAttendance } = eventService;
const { WORK_MODE } = policyRules;

// ── Fakes ────────────────────────────────────────────────────

const chain = (resolve) => {
  const self = {
    sort: () => self,
    lean: () => self,
    select: () => self,
    then: (resolvePromise, rejectPromise) =>
      Promise.resolve().then(resolve).then(resolvePromise, rejectPromise),
  };
  return self;
};

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((clause) => matches(row, clause));
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      if (value.$in) {
        const actual = row[key] === undefined ? 'null' : String(row[key]);
        return value.$in.map(String).includes(actual);
      }
      if (value.$ne !== undefined) {
        if (Array.isArray(value.$ne)) return true;
        return String(row[key] ?? '') !== String(value.$ne ?? '');
      }
      if (value.$exists !== undefined) {
        const exists = row[key] !== undefined;
        return value.$exists ? exists : !exists;
      }
      return true;
    }
    return String(row[key] ?? '') === String(value ?? '');
  });

const withToObject = (row) => ({ ...row, toObject() { return { ...this }; } });

const makeFakeLocationModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  let seq = rows.length + 1;
  return {
    rows,
    findOne: (filter) =>
      chain(() => {
        const found = rows.find((row) => matches(row, filter));
        return found ? { ...found } : null;
      }),
    find: (filter) =>
      chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    create: async (doc) => {
      const row = { ...doc, _id: `loc${seq}`, createdAt: new Date(), updatedAt: new Date() };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
    findOneAndUpdate: async (filter, update) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      row.updatedAt = new Date();
      return withToObject(row);
    },
  };
};

const makeFakeAttendanceModel = () => {
  const rows = [];
  let seq = 1;
  return {
    rows,
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      if (update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) {
          row[key] = Number(row[key] || 0) + delta;
        }
      }
      return opts.new ? row : { ...row };
    },
    create: async (doc) => {
      const dup = rows.find(
        (row) => String(row.user) === String(doc.user) && String(row.date) === String(doc.date),
      );
      if (dup) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      const row = { ...doc, _id: `att${seq}`, id: `att${seq}` };
      seq += 1;
      rows.push(row);
      return row;
    },
  };
};

const makeFakeEventModel = () => {
  const rows = [];
  let seq = 1;
  return {
    rows,
    findOne: (filter) =>
      chain(() => {
        const found = rows.find((row) => matches(row, filter));
        return found ? { ...found } : null;
      }),
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    create: async (doc) => {
      const dupSeq = rows.find(
        (row) =>
          String(row.companyId) === String(doc.companyId) &&
          String(row.user) === String(doc.user) &&
          String(row.date) === String(doc.date) &&
          Number(row.seq) === Number(doc.seq),
      );
      if (dupSeq) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      if (doc.requestId) {
        const dupKey = rows.find(
          (row) =>
            String(row.companyId) === String(doc.companyId) &&
            String(row.user) === String(doc.user) &&
            String(row.requestId || '') === String(doc.requestId),
        );
        if (dupKey) {
          const err = new Error('duplicate key');
          err.code = 11000;
          throw err;
        }
      }
      const row = { ...doc, _id: `evt${seq}`, id: `evt${seq}` };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
  };
};

const OFFICE = {
  _id: LOC_OFFICE,
  companyId: COMPANY_A,
  name: 'Head Office',
  code: 'HQ',
  displayAddress: '1 Main Street',
  latitude: 12.9716,
  longitude: 77.5946,
  radiusMeters: 500,
  isActive: true,
};
const INSIDE = { latitude: 12.9716, longitude: 77.5946 }; // exactly at the office
const NEARBY = { latitude: 12.972, longitude: 77.595, accuracy: 12 }; // tens of meters off
const FARAWAY = { latitude: 13.0827, longitude: 80.2707 }; // ~290 km off

const makePolicy = (locationEnforcement) => ({
  version: 3,
  timezone: 'Asia/Kolkata',
  locationEnforcement,
  breaks: { includeInWorkedTime: false },
  workModes: { office: true, wfh: true, field: false, clientSite: false, businessTravel: false },
});

const makeGeoCtx = ({ enforcement = 'REQUIRED', locations = [OFFICE] } = {}) => {
  const AttendanceModel = makeFakeAttendanceModel();
  const AttendanceEventModel = makeFakeEventModel();
  const AttendanceLocationModel = makeFakeLocationModel(locations);
  const policy = makePolicy(enforcement);
  const deps = {
    AttendanceModel,
    AttendanceEventModel,
    AttendanceLocationModel,
    CompanyModel: { findById: () => ({ select: () => ({ lean: async () => ({ timezone: 'Asia/Kolkata' }) }) }) },
    policyReader: async () => ({ policy, configured: true, hasActive: true }),
    engine: { evaluatePunch: () => ({ status: 'PRESENT', lateMinutes: 0 }) },
    resolveScheduleRule: async () => ({
      rule: {
        name: 'Default schedule',
        startTime: '09:00',
        endTime: '18:00',
        breakMinutes: 0,
        graceMinutes: 15,
        minWorkingHours: 8,
        halfDayHours: 4,
        overtimeEligible: false,
      },
      shift: null,
      schedule: null,
      source: 'DEFAULT',
    }),
    now: () => new Date('2026-09-14T09:00:00+05:30'),
    sleep: async () => {},
  };
  return { deps, AttendanceModel, AttendanceEventModel, AttendanceLocationModel, policy };
};

const punch = (ctx, action, overrides = {}) =>
  recordEvent({
    companyId: COMPANY_A,
    userId: USER_A,
    action,
    workMode: null,
    date: null,
    idempotencyKey: null,
    location: null,
    deps: ctx.deps,
    ...overrides,
  });

// ── PURE RULES ───────────────────────────────────────────────

test('rules: latitude bounds accept edges, refuse the rest', () => {
  assert.equal(validateLatitude(-90), null);
  assert.equal(validateLatitude(90), null);
  assert.equal(validateLatitude(12.9716), null);
  assert.match(validateLatitude(-90.0001), /between/);
  assert.match(validateLatitude(90.0001), /between/);
  assert.match(validateLatitude(Number.NaN), /finite/);
  assert.match(validateLatitude(Infinity), /finite/);
  assert.match(validateLatitude('12.9'), /finite/);
  assert.match(validateLatitude(null), /finite/);
  assert.match(validateLatitude(undefined), /finite/);
});

test('rules: longitude bounds accept edges, refuse the rest', () => {
  assert.equal(validateLongitude(-180), null);
  assert.equal(validateLongitude(180), null);
  assert.equal(validateLongitude(77.5946), null);
  assert.match(validateLongitude(-180.0001), /between/);
  assert.match(validateLongitude(180.0001), /between/);
  assert.match(validateLongitude(Number.NaN), /finite/);
  assert.match(validateLongitude(Infinity), /finite/);
  assert.match(validateLongitude('77.5'), /finite/);
  assert.match(validateLongitude(null), /finite/);
});

test('rules: radius accepts the fenced integer range only', () => {
  assert.equal(validateRadiusMeters(10), null);
  assert.equal(validateRadiusMeters(500), null);
  assert.equal(validateRadiusMeters(100000), null);
  assert.match(validateRadiusMeters(0), /between/);
  assert.match(validateRadiusMeters(9), /between/);
  assert.match(validateRadiusMeters(100001), /between/);
  assert.match(validateRadiusMeters(2.5), /integer/);
  assert.match(validateRadiusMeters(Number.NaN), /integer/);
  assert.match(validateRadiusMeters('500'), /integer/);
});

test('rules: accuracy shape accepts any real non-negative reading', () => {
  assert.equal(validateAccuracyMeters(undefined), null);
  assert.equal(validateAccuracyMeters(null), null);
  assert.equal(validateAccuracyMeters(0), null);
  assert.equal(validateAccuracyMeters(25), null);
  // 31.16 D-03 — imprecise-but-real is well-formed (desktop IP fixes
  // routinely exceed the cap); usability is a verdict question.
  assert.equal(validateAccuracyMeters(100000), null);
  assert.equal(validateAccuracyMeters(250000), null);
  assert.match(validateAccuracyMeters(-1), /0 or greater/);
  assert.match(validateAccuracyMeters(Number.NaN), /finite/);
  assert.match(validateAccuracyMeters(Infinity), /finite/);
});

test('rules: accuracy usability gates verification, not request shape', () => {
  assert.equal(isAccuracyUsable(undefined), true);
  assert.equal(isAccuracyUsable(null), true);
  assert.equal(isAccuracyUsable(100000), true);
  assert.equal(isAccuracyUsable(100001), false);
  assert.equal(isAccuracyUsable(2500000), false);
});

test('rules: same point measures near-zero distance', () => {
  assert.equal(haversineMeters(12.9716, 77.5946, 12.9716, 77.5946), 0);
});

test('rules: known pair produces the expected approximate distance', () => {
  // Bengaluru → Chennai ≈ 291 km; tolerance swallows formula rounding.
  const meters = haversineMeters(12.9716, 77.5946, 13.0827, 80.2707);
  assert.ok(meters > 285000 && meters < 296000, `expected ~291km, got ${meters}m`);
});

test('rules: geofence boundary is inclusive and deterministic', () => {
  assert.equal(isInsideGeofence(100, 100), true);
  assert.equal(isInsideGeofence(0, 10), true);
  assert.equal(isInsideGeofence(101, 100), false);
  assert.equal(isInsideGeofence(290900, 500), false);
});

test('rules: requirement matrix — geofence binds OFFICE only', () => {
  assert.equal(geofenceRequirement(makePolicy('DISABLED'), WORK_MODE.OFFICE), 'NONE');
  assert.equal(geofenceRequirement(makePolicy('REQUIRED'), WORK_MODE.OFFICE), 'REQUIRED');
  assert.equal(geofenceRequirement(makePolicy('OPTIONAL'), WORK_MODE.OFFICE), 'OPTIONAL');
  assert.equal(geofenceRequirement(makePolicy('REQUIRED'), WORK_MODE.WFH), 'NONE');
  assert.equal(geofenceRequirement(makePolicy('REQUIRED'), WORK_MODE.FIELD), 'NONE');
  assert.equal(geofenceRequirement(makePolicy('OPTIONAL'), WORK_MODE.CLIENT_SITE), 'NONE');
  assert.equal(geofenceRequirement(makePolicy('REQUIRED'), WORK_MODE.BUSINESS_TRAVEL), 'NONE');
  assert.equal(geofenceRequirement(null, WORK_MODE.OFFICE), 'NONE');
  assert.equal(geofenceRequirement({}, WORK_MODE.OFFICE), 'NONE');
});

test('rules: snapshot carries rule facts, never employee coordinates', () => {
  const snapshot = buildVerificationSnapshot({
    location: OFFICE,
    distanceMeters: 42,
    result: 'VERIFIED',
    accuracyMeters: 12,
    verifiedAt: new Date('2026-09-14T09:00:00+05:30'),
  });
  assert.equal(snapshot.locationId, LOC_OFFICE);
  assert.equal(snapshot.locationName, 'Head Office');
  assert.equal(snapshot.radiusMeters, 500);
  assert.equal(snapshot.distanceMeters, 42);
  assert.equal(snapshot.result, 'VERIFIED');
  assert.equal(snapshot.accuracyMeters, 12);
  assert.ok(snapshot.verifiedAt instanceof Date);
  const keys = JSON.stringify(snapshot);
  assert.ok(!keys.includes('12.9716') && !keys.includes('latitude') && !keys.includes('position'));
});

test('rules: location input validation aggregates field errors', () => {
  assert.deepEqual(
    validateLocationInput({ name: 'HQ', latitude: 12.9, longitude: 77.5, radiusMeters: 500 }),
    [],
  );
  const errors = validateLocationInput({ name: '  ', latitude: 200, longitude: 77.5, radiusMeters: 5 });
  assert.ok(errors.some((error) => error.includes('name is required')));
  assert.ok(errors.some((error) => error.includes('latitude')));
  assert.ok(errors.some((error) => error.includes('radiusMeters')));
  assert.ok(
    validateLocationInput({ name: 'x'.repeat(81), latitude: 0, longitude: 0, radiusMeters: 10 }).some(
      (error) => error.includes('name'),
    ),
  );
});

// ── LOCATION SERVICE ─────────────────────────────────────────

test('service: create stores the location and audits without employee data', async () => {
  const calls = [];
  const AttendanceLocationModel = makeFakeLocationModel();
  const created = await createLocation({
    companyId: COMPANY_A,
    input: { ...OFFICE, _id: undefined, companyId: undefined },
    actor: { _id: USER_A },
    audit: async (args) => calls.push(args),
    AttendanceLocationModel,
  });
  assert.equal(created.name, 'Head Office');
  assert.equal(created.latitude, 12.9716);
  assert.equal(created.isActive, true);
  assert.equal(AttendanceLocationModel.rows[0].companyId, COMPANY_A);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'ATTENDANCE_LOCATION_CREATED');
  assert.equal(calls[0].resource, 'AttendanceLocation');
  assert.equal(calls[0].newValue.radiusMeters, 500);
});

test('service: create refuses invalid coordinates and radius', async () => {
  const AttendanceLocationModel = makeFakeLocationModel();
  await assert.rejects(
    () => createLocation({ companyId: COMPANY_A, input: { name: 'Bad', latitude: 91, longitude: 0, radiusMeters: 50 }, AttendanceLocationModel }),
    /latitude/,
  );
  await assert.rejects(
    () => createLocation({ companyId: COMPANY_A, input: { name: 'Bad', latitude: 0, longitude: 0, radiusMeters: 5 }, AttendanceLocationModel }),
    /radiusMeters/,
  );
  await assert.rejects(
    () => createLocation({ companyId: COMPANY_A, input: { latitude: 0, longitude: 0, radiusMeters: 50 }, AttendanceLocationModel }),
    /name is required/,
  );
  assert.equal(AttendanceLocationModel.rows.length, 0);
});

test('service: update validates the merged shape and audits', async () => {
  const calls = [];
  const AttendanceLocationModel = makeFakeLocationModel([OFFICE]);
  const updated = await updateLocation({
    companyId: COMPANY_A,
    locationId: LOC_OFFICE,
    input: { radiusMeters: 750 },
    actor: { _id: USER_A },
    audit: async (args) => calls.push(args),
    AttendanceLocationModel,
  });
  assert.equal(updated.radiusMeters, 750);
  assert.equal(updated.name, 'Head Office');
  assert.equal(calls[0].action, 'ATTENDANCE_LOCATION_UPDATED');
  assert.equal(calls[0].newValue.radiusMeters, 750);
  await assert.rejects(
    () => updateLocation({ companyId: COMPANY_A, locationId: LOC_OFFICE, input: { latitude: -100 }, AttendanceLocationModel }),
    /latitude/,
  );
  assert.equal(AttendanceLocationModel.rows[0].latitude, 12.9716);
});

test('service: get is tenant-scoped (foreign id is not found)', async () => {
  const AttendanceLocationModel = makeFakeLocationModel([OFFICE]);
  const found = await getLocation({ companyId: COMPANY_A, locationId: LOC_OFFICE, AttendanceLocationModel });
  assert.equal(found.name, 'Head Office');
  await assert.rejects(
    () => getLocation({ companyId: COMPANY_B, locationId: LOC_OFFICE, AttendanceLocationModel }),
    /not found/,
  );
  await assert.rejects(
    () => getLocation({ companyId: COMPANY_A, locationId: 'missing', AttendanceLocationModel }),
    /not found/,
  );
});

test('service: list returns only the caller tenant rows', async () => {
  const AttendanceLocationModel = makeFakeLocationModel([
    OFFICE,
    { ...OFFICE, _id: LOC_REMOTE, companyId: COMPANY_B, name: 'Other Co Office' },
  ]);
  const rows = await listLocations({ companyId: COMPANY_A, AttendanceLocationModel });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Head Office');
});

test('service: deactivate keeps history referenceable, eligible hides it', async () => {
  const calls = [];
  const AttendanceLocationModel = makeFakeLocationModel([OFFICE]);
  const off = await setLocationActive({
    companyId: COMPANY_A,
    locationId: LOC_OFFICE,
    isActive: false,
    actor: { _id: USER_A },
    audit: async (args) => calls.push(args),
    AttendanceLocationModel,
  });
  assert.equal(off.isActive, false);
  assert.equal(calls[0].action, 'ATTENDANCE_LOCATION_DEACTIVATED');
  // Historical reference still resolves (no delete path exists).
  const stillThere = await getLocation({ companyId: COMPANY_A, locationId: LOC_OFFICE, AttendanceLocationModel });
  assert.equal(stillThere.name, 'Head Office');
  const eligible = await listEligibleLocations({ companyId: COMPANY_A, AttendanceLocationModel });
  assert.equal(eligible.length, 0);
  const on = await setLocationActive({
    companyId: COMPANY_A,
    locationId: LOC_OFFICE,
    isActive: true,
    audit: async (args) => calls.push(args),
    AttendanceLocationModel,
  });
  assert.equal(on.isActive, true);
  assert.equal(calls[1].action, 'ATTENDANCE_LOCATION_ACTIVATED');
});

test('service: eligible exposes safe picker fields only', async () => {
  const AttendanceLocationModel = makeFakeLocationModel([OFFICE]);
  const [row] = await listEligibleLocations({ companyId: COMPANY_A, AttendanceLocationModel });
  assert.deepEqual(Object.keys(row).sort(), ['code', 'displayAddress', 'id', 'name']);
});

test('service: body companyId can never override req.companyId', async () => {
  const AttendanceLocationModel = makeFakeLocationModel();
  await createLocation({
    companyId: COMPANY_A,
    input: { name: 'Sneaky', latitude: 0, longitude: 0, radiusMeters: 50, companyId: COMPANY_B },
    audit: async () => {},
    AttendanceLocationModel,
  });
  assert.equal(AttendanceLocationModel.rows[0].companyId, COMPANY_A);
});

// ── RBAC ─────────────────────────────────────────────────────

test('rbac: location permissions exist with least-privilege defaults', () => {
  const names = registry.DEFAULT_PERMISSIONS.map((permission) => permission.name);
  assert.ok(names.includes('ATTENDANCE_LOCATION_READ'));
  assert.ok(names.includes('ATTENDANCE_LOCATION_MANAGE'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('ATTENDANCE_LOCATION_READ'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('ATTENDANCE_LOCATION_MANAGE'));
  assert.ok(!registry.DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('ATTENDANCE_LOCATION_READ'));
  assert.ok(!registry.DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('ATTENDANCE_LOCATION_MANAGE'));
  assert.ok(!registry.DEFAULT_ROLE_MATRIX.MANAGER.includes('ATTENDANCE_LOCATION_MANAGE'));
});

// ── CLOCK_IN GEOFENCE INTEGRATION ────────────────────────────

test('clock-in: REQUIRED + inside geofence succeeds with a VERIFIED snapshot', async () => {
  const ctx = makeGeoCtx();
  const result = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-in-a',
    location: { locationId: LOC_OFFICE, position: { ...NEARBY } },
  });
  assert.equal(result.replayed, false);
  assert.equal(result.snapshot.liveState, 'WORKING');
  const snapshot = result.event.location;
  assert.equal(snapshot.locationId, LOC_OFFICE);
  assert.equal(snapshot.locationName, 'Head Office');
  assert.equal(snapshot.radiusMeters, 500);
  assert.equal(snapshot.result, 'VERIFIED');
  assert.equal(snapshot.accuracyMeters, 12);
  assert.ok(snapshot.verifiedAt);
  assert.ok(snapshot.distanceMeters > 0 && snapshot.distanceMeters < 500);
});

test('clock-in: backend computes distance independently (no client facts)', async () => {
  const ctx = makeGeoCtx();
  const result = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-in-b',
    location: { locationId: LOC_OFFICE, position: { ...NEARBY } },
  });
  const expected = haversineMeters(NEARBY.latitude, NEARBY.longitude, OFFICE.latitude, OFFICE.longitude);
  assert.equal(result.event.location.distanceMeters, expected);
});

test('clock-in: raw employee coordinates are never retained', async () => {
  const ctx = makeGeoCtx();
  await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-in-c',
    location: { locationId: LOC_OFFICE, position: { ...NEARBY } },
  });
  const stored = ctx.AttendanceEventModel.rows[0];
  const blob = JSON.stringify(stored);
  assert.ok(!('position' in stored));
  assert.ok(!('latitude' in stored) && !('longitude' in stored));
  assert.ok(!blob.includes('12.972') && !blob.includes('77.595'));
});

test('clock-in: REQUIRED + missing position is refused, nothing written', async () => {
  const ctx = makeGeoCtx();
  await assert.rejects(() => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE' }), /required by company policy/);
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', location: { locationId: LOC_OFFICE, position: null } }),
    /required by company policy/,
  );
  assert.equal(ctx.AttendanceModel.rows.length, 0);
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('clock-in: REQUIRED + outside radius is refused, nothing written', async () => {
  const ctx = makeGeoCtx();
  const err = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    location: { locationId: LOC_OFFICE, position: { ...FARAWAY } },
  }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(err);
  assert.equal(err.statusCode, 403);
  assert.match(err.message, /outside the allowed radius for Head Office/);
  assert.equal(ctx.AttendanceModel.rows.length, 0);
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('clock-in: REQUIRED + imprecise fix fails verification (never a 400), nothing written', async () => {
  const ctx = makeGeoCtx();
  const err = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    // Center point is exactly the office — but a 250 km error radius
    // proves nothing, so this must fail as OUTSIDE, not as malformed.
    location: { locationId: LOC_OFFICE, position: { ...INSIDE, accuracy: 250000 } },
  }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(err);
  assert.equal(err.statusCode, 403);
  assert.match(err.message, /outside the allowed radius for Head Office/);
  assert.equal(ctx.AttendanceModel.rows.length, 0);
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('clock-in: OPTIONAL + imprecise fix proceeds with OUTSIDE evidence (raw value kept)', async () => {
  const ctx = makeGeoCtx({ enforcement: 'OPTIONAL' });
  const result = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-opt-imprecise',
    location: { locationId: LOC_OFFICE, position: { ...INSIDE, accuracy: 250000 } },
  });
  assert.equal(result.snapshot.liveState, 'WORKING');
  assert.equal(result.event.location.result, 'OUTSIDE');
  assert.equal(result.event.location.accuracyMeters, 250000);
});

test('clock-in: REQUIRED + inactive/foreign/unknown location is refused', async () => {
  const inactive = { ...OFFICE, isActive: false };
  const foreign = { ...OFFICE, _id: LOC_REMOTE, companyId: COMPANY_B };
  const ctx = makeGeoCtx({ locations: [inactive, foreign] });
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', location: { locationId: LOC_OFFICE, position: { ...INSIDE } } }),
    /no longer active/,
  );
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', location: { locationId: LOC_REMOTE, position: { ...INSIDE } } }),
    /not found/,
  );
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', location: { locationId: 'missing', position: { ...INSIDE } } }),
    /not found/,
  );
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('clock-in: position without locationId is refused', async () => {
  const ctx = makeGeoCtx();
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', location: { locationId: null, position: { ...INSIDE } } }),
    /locationId is required/,
  );
});

test('clock-in: malformed position is refused even before measurement', async () => {
  const ctx = makeGeoCtx();
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', location: { locationId: LOC_OFFICE, position: { latitude: 'x', longitude: 77.5 } } }),
    /latitude/,
  );
});

test('clock-in: same-key retry preserves the original snapshot', async () => {
  const ctx = makeGeoCtx();
  const first = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-replay-a',
    location: { locationId: LOC_OFFICE, position: { ...INSIDE } },
  });
  const retry = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-replay-a',
    location: { locationId: LOC_OFFICE, position: { ...NEARBY } },
  });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.event.location, first.event.location);
  assert.equal(retry.event.location.distanceMeters, 0);
  assert.equal(ctx.AttendanceEventModel.rows.length, 1);
});

test('clock-in: OPTIONAL verifies when supplied, never blocks', async () => {
  const ctx = makeGeoCtx({ enforcement: 'OPTIONAL' });
  const verified = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-opt-a',
    location: { locationId: LOC_OFFICE, position: { ...NEARBY } },
  });
  assert.equal(verified.event.location.result, 'VERIFIED');
  // Fresh session for the outside attempt (same key space, new user-day).
  const ctx2 = makeGeoCtx({ enforcement: 'OPTIONAL' });
  const outside = await punch(ctx2, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-opt-b',
    location: { locationId: LOC_OFFICE, position: { ...FARAWAY } },
  });
  assert.equal(outside.snapshot.liveState, 'WORKING');
  assert.equal(outside.event.location.result, 'OUTSIDE');
  assert.ok(outside.event.location.distanceMeters > 500);
});

test('clock-in: OPTIONAL + nothing supplied proceeds without a snapshot', async () => {
  const ctx = makeGeoCtx({ enforcement: 'OPTIONAL' });
  const plain = await punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'geo-opt-c' });
  assert.equal(plain.event.location, null);
  const ctx2 = makeGeoCtx({ enforcement: 'OPTIONAL' });
  const chosen = await punch(ctx2, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-opt-d',
    location: { locationId: LOC_OFFICE, position: null },
  });
  assert.equal(chosen.event.location, null);
});

test('clock-in: OPTIONAL still refuses foreign location references', async () => {
  const foreign = { ...OFFICE, _id: LOC_REMOTE, companyId: COMPANY_B };
  const ctx = makeGeoCtx({ enforcement: 'OPTIONAL', locations: [OFFICE, foreign] });
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', location: { locationId: LOC_REMOTE, position: { ...INSIDE } } }),
    /not found/,
  );
});

test('clock-in: REQUIRED + WFH proceeds with no fake verification', async () => {
  const ctx = makeGeoCtx();
  const result = await punch(ctx, 'CLOCK_IN', {
    workMode: 'WFH',
    idempotencyKey: 'geo-wfh-a',
    location: { locationId: LOC_OFFICE, position: { ...INSIDE } },
  });
  assert.equal(result.snapshot.liveState, 'WORKING');
  assert.equal(result.snapshot.workMode, 'WFH');
  assert.equal(result.event.location, null);
});

test('clock-in: DISABLED discards supplied position, no snapshot', async () => {
  const ctx = makeGeoCtx({ enforcement: 'DISABLED' });
  const result = await punch(ctx, 'CLOCK_IN', {
    workMode: 'OFFICE',
    idempotencyKey: 'geo-off-a',
    location: { locationId: LOC_OFFICE, position: { ...INSIDE } },
  });
  assert.equal(result.snapshot.liveState, 'WORKING');
  assert.equal(result.event.location, null);
  assert.ok(!('locationVerification' in ctx.AttendanceEventModel.rows[0]));
});

test('clock-in: live snapshot carries enforcement for the employee UI', async () => {
  const ctx = makeGeoCtx();
  const live = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx.deps });
  assert.equal(live.locationEnforcement, 'REQUIRED');
  const ctx2 = makeGeoCtx({ enforcement: 'DISABLED' });
  const live2 = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx2.deps });
  assert.equal(live2.locationEnforcement, 'DISABLED');
});

// ── EVENT VALIDATOR ──────────────────────────────────────────

const runValidatorChain = async (body) => {
  const req = { body, query: {} };
  for (const middleware of eventValidator.attendanceEventValidator) {
    // next()-style and promise-style middleware both settle this.
    await new Promise((resolve, reject) => {
      Promise.resolve(middleware(req, {}, (err) => (err ? reject(err) : resolve()))).then(
        () => resolve(),
        (err) => reject(err),
      );
    });
  }
};

test('validator: client geofence verdicts are refused outright', async () => {
  await assert.rejects(
    () => runValidatorChain({ action: 'CLOCK_IN', insideGeofence: true }),
    /insideGeofence must not be supplied/,
  );
  await assert.rejects(
    () => runValidatorChain({ action: 'CLOCK_IN', distanceMeters: 3 }),
    /distanceMeters must not be supplied/,
  );
  await assert.rejects(
    () => runValidatorChain({ action: 'CLOCK_IN', location: { locationId: LOC_OFFICE } }),
    /location must not be supplied/,
  );
});

test('validator: legitimate CLOCK_IN + location payload passes', async () => {
  await runValidatorChain({
    action: 'CLOCK_IN',
    workMode: 'OFFICE',
    locationId: LOC_OFFICE,
    position: { latitude: 12.9716, longitude: 77.5946, accuracy: 10 },
    idempotencyKey: 'validator-ok-1',
  });
});

test('validator: tenant override is still refused', async () => {
  await assert.rejects(
    () => runValidatorChain({ action: 'CLOCK_IN', companyId: COMPANY_B }),
    /companyId must not be supplied/,
  );
});
