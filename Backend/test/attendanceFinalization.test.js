// ─────────────────────────────────────────────────────────────
// Phase 31.11 — Monthly attendance finalization & payroll sync.
// Hermetic: every Mongo collaborator is an in-memory fake with a
// faithful matcher AND faithful unique indexes (concurrency is
// really tested — the second claim hits 11000). The 31.10
// derivation it builds on is REAL (no attendance facts are
// stubbed); the clock is fixed; no test touches the network,
// Redis, payroll money, or the real database.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINALIZATION_ISSUE,
  FINALIZATION_STATUS,
  aggregateMonth,
  buildAutoFromSnapshot,
  canTransition,
  deriveEmployeeSnapshot,
  effectiveBucket,
  fingerprintOf,
  fractionsValid,
  isBlocker,
  nextVersion,
  payrollGates,
  readinessOf,
  validateDay,
} from '../src/services/attendance/attendanceFinalizationRules.js';
import {
  finalizeMonth,
  getFinalizationStatus,
  previewFinalization,
  reopenMonth,
  sendToPayroll,
  validateFinalization,
} from '../src/services/attendance/attendanceFinalizationService.js';
import { makeMonthlyInputService } from '../src/services/payroll/monthlyInputService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

const TZ = 'Asia/Kolkata';
const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const U_REP1 = '100000000000000000000002';
const U_REP2 = '100000000000000000000003';
const U_HR = '100000000000000000000005';
const U_B = '200000000000000000000001';

// Tue 2026-09-15 10:00 IST — frozen today; scope = Sep 1–14.
const TUE_10AM = new Date('2026-09-15T04:30:00.000Z');
const SEP = '2026-09';

const actor = (id, role, name = 'Actor') => ({ _id: id, role, name });
const dt = (isoString) => new Date(`${isoString}.000Z`);

// ── Faithful matcher (equality incl. Dates/null-missing, $in,
// $ne, $gte/$lte/$gt/$lt, $exists, $or, $regex) ─────────────────

const cmpVal = (a, b) => {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

const matchCond = (docVal, cond) => {
  if (cond instanceof RegExp) return cond.test(String(docVal ?? ''));
  if (Array.isArray(docVal) && (cond === null || typeof cond !== 'object' || cond instanceof Date)) {
    return docVal.some((entry) => matchCond(entry, cond));
  }
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.keys(cond).every((op) => {
      const want = cond[op];
      if (op === '$in') return Array.isArray(want) && want.some((v) => cmpVal(docVal, v) === 0);
      if (op === '$ne') return cmpVal(docVal, want) !== 0;
      if (op === '$gte') return cmpVal(docVal, want) >= 0;
      if (op === '$lte') return cmpVal(docVal, want) <= 0;
      if (op === '$gt') return cmpVal(docVal, want) > 0;
      if (op === '$lt') return cmpVal(docVal, want) < 0;
      if (op === '$exists') return want ? docVal !== undefined : docVal === undefined;
      if (op === '$regex') return new RegExp(want, cond.$options || '').test(String(docVal ?? ''));
      if (op === '$options') return true;
      throw new Error(`unsupported operator ${op}`);
    });
  }
  if (cond === null) return docVal === null || docVal === undefined;
  return cmpVal(docVal, cond) === 0;
};

const matchDoc = (doc, filter = {}) => Object.entries(filter).every(([key, cond]) => {
  if (key === '$or') return Array.isArray(cond) && cond.some((branch) => matchDoc(doc, branch));
  if (key === '$and') return Array.isArray(cond) && cond.every((branch) => matchDoc(doc, branch));
  return matchCond(doc?.[key], cond);
});

const getPath = (doc, path) => path.split('.').reduce((node, key) => node?.[key], doc);
const setPath = (doc, path, value) => {
  const keys = path.split('.');
  let node = doc;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (node[keys[i]] === null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
};
const unsetPath = (doc, path) => {
  const keys = path.split('.');
  let node = doc;
  for (let i = 0; i < keys.length - 1; i += 1) {
    node = node?.[keys[i]];
    if (!node) return;
  }
  delete node[keys[keys.length - 1]];
};

// $[identifier] writes (versions.$[entry].sentToPayrollAt) with the
// service's arrayFilters shape [{ 'entry.version': N }].
const applyUpdate = (doc, update = {}, arrayFilters = []) => {
  const matchArrayElement = (identifier, element) =>
    (arrayFilters || []).every((filter) => Object.entries(filter).every(([key, want]) => {
      const prefix = `${identifier}.`;
      if (!key.startsWith(prefix)) return true;
      return matchCond(getPath(element, key.slice(prefix.length)), want);
    }));
  const setOne = (path, value) => {
    const m = path.match(/^(\w+)\.\$\[(\w+)\]\.(.+)$/);
    if (!m) return setPath(doc, path, value);
    const [, arrayKey, identifier, rest] = m;
    for (const element of doc[arrayKey] || []) {
      if (matchArrayElement(identifier, element)) setPath(element, rest, value);
    }
  };
  for (const [path, value] of Object.entries(update.$set || {})) setOne(path, value);
  for (const path of Object.keys(update.$unset || {})) unsetPath(doc, path);
  for (const [path, value] of Object.entries(update.$push || {})) {
    const list = getPath(doc, path);
    if (Array.isArray(list)) list.push(value);
    else setPath(doc, path, [value]);
  }
};

const dupError = () => {
  const error = new Error('E11000 duplicate key');
  error.code = 11000;
  return error;
};

const sortRows = (rows, spec = {}) => {
  const keys = Object.entries(spec);
  if (!keys.length) return rows;
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const cmp = cmpVal(a?.[key] ?? '', b?.[key] ?? '');
      if (cmp !== 0) return dir === -1 ? -cmp : cmp;
    }
    return 0;
  });
};

// Writable fake collection with faithful unique indexes.
const fakeCollection = ({ rows = [], uniques = [], counter = null, name = 'model' } = {}) => {
  const store = rows;
  const keyOf = (doc, keys) => keys.map((key) => String(getPath(doc, key) ?? '')).join('|');
  const violates = (doc, ignore = null) => uniques.some(
    (keys) => store.some((row) => row !== ignore && keyOf(row, keys) === keyOf(doc, keys)),
  );

  const docOf = (row) => {
    const doc = { ...row };
    doc.save = async () => {
      const { save, ...rest } = doc;
      void save;
      Object.assign(row, rest);
      return row;
    };
    return doc;
  };

  const query = (row) => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => (row ? { ...row } : null),
    then(resolve) { resolve(row ? docOf(row) : null); },
  });

  return {
    _store: store,
    find: (filter = {}) => {
      counter?.(name, 'find', filter);
      const hits = store.filter((row) => matchDoc(row, filter));
      const q = {
        _rows: hits,
        select() { return q; },
        sort(spec) { q._rows = sortRows(q._rows, spec); return q; },
        skip(n) { q._rows = q._rows.slice(n); return q; },
        limit(n) { q._rows = q._rows.slice(0, n); return q; },
        lean: async () => q._rows.map((row) => ({ ...row })),
      };
      return q;
    },
    findOne: (filter = {}) => {
      counter?.(name, 'findOne', filter);
      return query(store.find((row) => matchDoc(row, filter)) || null);
    },
    findOneAndUpdate: (filter = {}, update = {}, options = {}) => {
      counter?.(name, 'findOneAndUpdate', filter);
      const apply = () => {
        let row = store.find((entry) => matchDoc(entry, filter));
        if (!row && options.upsert) {
          row = { _id: `fake-${store.length + 1}` };
          for (const [key, cond] of Object.entries(filter)) {
            if (cond !== null && typeof cond !== 'object') row[key] = cond;
          }
          Object.assign(row, update.$setOnInsert || {});
          applyUpdate(row, update, options.arrayFilters);
          if (violates(row)) throw dupError();
          store.push(row);
          return row;
        }
        if (!row) return null;
        applyUpdate(row, update, options.arrayFilters);
        return row;
      };
      let result;
      let failure = null;
      try {
        result = apply();
      } catch (error) {
        failure = error;
      }
      return {
        select() { return this; },
        lean: async () => {
          if (failure) throw failure;
          return result ? { ...result } : null;
        },
      };
    },
    updateOne: (filter = {}, update = {}, options = {}) => {
      counter?.(name, 'updateOne', filter);
      const row = store.find((entry) => matchDoc(entry, filter));
      if (row) {
        applyUpdate(row, update, options.arrayFilters);
        return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
      }
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const created = { _id: `fake-${store.length + 1}` };
      for (const [key, cond] of Object.entries(filter)) {
        if (cond !== null && typeof cond !== 'object') created[key] = cond;
      }
      Object.assign(created, update.$setOnInsert || {});
      applyUpdate(created, update, options.arrayFilters);
      if (violates(created)) throw dupError();
      store.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedId: created._id };
    },
    updateMany: (filter = {}, update = {}) => {
      counter?.(name, 'updateMany', filter);
      let matched = 0;
      for (const row of store.filter((entry) => matchDoc(entry, filter))) {
        applyUpdate(row, update, []);
        matched += 1;
      }
      return { matchedCount: matched, modifiedCount: matched };
    },
    create: async (doc = {}) => {
      counter?.(name, 'create', doc);
      const created = { _id: `fake-${store.length + 1}`, ...doc };
      if (violates(created)) throw dupError();
      store.push(created);
      return docOf(created);
    },
    exists: async (filter = {}) => {
      counter?.(name, 'exists', filter);
      return store.some((row) => matchDoc(row, filter)) ? { _id: 'x' } : null;
    },
    countDocuments: async (filter = {}) => store.filter((row) => matchDoc(row, filter)).length,
  };
};

// ── Fixtures ───────────────────────────────────────────────────

const userDoc = (id, companyId, overrides = {}) => ({
  _id: id,
  companyId,
  status: 'ACTIVE',
  name: `User ${id.slice(-4)}`,
  employeeCode: `E${id.slice(-4)}`,
  designation: 'Engineer',
  department: null,
  dateOfJoining: null,
  ...overrides,
});

const controlDoc = (user, date, overrides = {}) => ({
  _id: `c-${user.slice(-4)}-${date}`,
  companyId: COMPANY_A,
  user,
  date,
  punchIn: null,
  punchOut: null,
  workMinutes: 0,
  breakMinutes: 0,
  lateMinutes: 0,
  earlyMinutes: 0,
  status: 'PRESENT',
  liveState: null,
  workMode: 'OFFICE',
  policyExceptions: [],
  overtimeMinutes: 0,
  ...overrides,
});

const buildDeps = ({
  users = [],
  controls = [],
  events = [],
  leaves = [],
  regs = [],
  ots = [],
  periods = [],
  snapshots = [],
  inputs = [],
  payrollPeriod = null,
  run = null,
  review = null,
  batches = [],
  payments = [],
  payslips = [],
  resignations = [],
  shifts = [],
  schedules = [],
  holidays = [],
  setupOtPolicy = null,
  counter = null,
  failInputSyncFor = [],
} = {}) => {
  const audits = [];
  const notifications = [];
  const cacheKeys = [];
  const failSet = new Set(failInputSyncFor);
  const inputColl = fakeCollection({
    rows: inputs,
    uniques: [['companyId', 'month', 'employeeId']],
    counter,
    name: 'Input',
  });
  const rawInputUpdateOne = inputColl.updateOne;
  inputColl.updateOne = (filter = {}, update = {}, options = {}) => {
    if (failSet.has(String(filter?.employeeId))) throw new Error('input sync boom');
    return rawInputUpdateOne(filter, update, options);
  };

  const deps = {
    UserModel: fakeCollection({ rows: users, counter, name: 'User' }),
    ResignationModel: fakeCollection({ rows: resignations, counter, name: 'Resignation' }),
    AttendanceModel: fakeCollection({ rows: controls, counter, name: 'Attendance' }),
    AttendanceEventModel: fakeCollection({ rows: events, counter, name: 'Event' }),
    LeaveModel: fakeCollection({ rows: leaves, counter, name: 'Leave' }),
    RegularizationModel: fakeCollection({ rows: regs, counter, name: 'Reg' }),
    OvertimeRequestModel: fakeCollection({ rows: ots, counter, name: 'OT' }),
    DepartmentModel: fakeCollection({ rows: [], counter, name: 'Department' }),
    CompanyModel: fakeCollection({ rows: [], counter, name: 'Company' }),
    ShiftAssignmentModel: fakeCollection({ rows: [], counter, name: 'Assign' }),
    ShiftModel: fakeCollection({ rows: shifts, counter, name: 'Shift' }),
    WorkScheduleModel: fakeCollection({ rows: schedules, counter, name: 'Schedule' }),
    HolidayModel: fakeCollection({ rows: holidays, counter, name: 'Holiday' }),
    AttendancePeriodModel: fakeCollection({
      rows: periods, uniques: [['companyId', 'month']], counter, name: 'Period',
    }),
    SnapshotModel: fakeCollection({
      rows: snapshots,
      uniques: [['companyId', 'month', 'employeeId', 'version']],
      counter,
      name: 'Snapshot',
    }),
    PayrollPeriodModel: fakeCollection({
      rows: payrollPeriod ? [payrollPeriod] : [], counter, name: 'PayrollPeriod',
    }),
    PayrollRunModel: fakeCollection({ rows: run ? [run] : [], counter, name: 'Run' }),
    PayrollReviewModel: fakeCollection({ rows: review ? [review] : [], counter, name: 'Review' }),
    PaymentBatchModel: fakeCollection({ rows: batches, counter, name: 'Batch' }),
    PayrollPaymentModel: fakeCollection({ rows: payments, counter, name: 'Payment' }),
    PayslipModel: fakeCollection({ rows: payslips, counter, name: 'Payslip' }),
    EmployeeMonthlyInputModel: inputColl,
    PayrollSetupModel: fakeCollection({
      rows: setupOtPolicy ? [{ _id: 'setup1', companyId: COMPANY_A, isCurrent: true, overtimePolicy: setupOtPolicy }] : [],
      counter,
      name: 'Setup',
    }),
    policyReader: async () => ({ policy: { id: 'policy1', version: 4, configVersion: 2, timezone: TZ, grace: {} } }),
    periodEnsurer: async ({ companyId, month }) => ({ _id: `pp-${month}`, companyId, month }),
    audit: async (payload) => { audits.push(payload); return null; },
    audience: async () => [],
    notify: async (payload) => { notifications.push(payload); return null; },
    cache: {
      buildKey: ({ companyId, namespace, version, segments }) =>
        `${namespace}:v${version}:${companyId}:${(segments || []).join(':')}`,
      del: async (key) => { cacheKeys.push(key); return true; },
    },
    now: () => TUE_10AM,
  };
  return { deps, audits, notifications, cacheKeys, stores: { periods, snapshots, inputs } };
};

// ── §54 pure: state machine ──────────────────────────────────

test('31.11 transitions allow the controlled lifecycle only', () => {
  assert.equal(canTransition('OPEN', 'FINALIZING'), true);
  assert.equal(canTransition('FINALIZING', 'FINALIZED'), true);
  assert.equal(canTransition('FINALIZING', 'OPEN'), true);
  assert.equal(canTransition('FINALIZED', 'SENT_TO_PAYROLL'), true);
  assert.equal(canTransition('FINALIZED', 'REOPENED'), true);
  assert.equal(canTransition('SENT_TO_PAYROLL', 'REOPENED'), true);
  assert.equal(canTransition('REOPENED', 'FINALIZING'), true);
  assert.equal(canTransition('OPEN', 'FINALIZED'), false);
  assert.equal(canTransition('OPEN', 'SENT_TO_PAYROLL'), false);
  assert.equal(canTransition('SENT_TO_PAYROLL', 'FINALIZED'), false);
  assert.equal(canTransition('REOPENED', 'OPEN'), false);
  assert.equal(nextVersion(0), 1);
  assert.equal(nextVersion(2), 3);
});

// ── §54 pure: fractions + day validation ───────────────────────

test('31.11 fractions reject impossible day units', () => {
  assert.equal(fractionsValid({ worked: 1, leave: 0, absent: 0 }), true);
  assert.equal(fractionsValid({ worked: 0.5, leave: 0.5, absent: 0 }), true);
  assert.equal(fractionsValid({ worked: 0, leave: 0, absent: 0 }), true);
  assert.equal(fractionsValid({ worked: 1, leave: 1, absent: 0 }), false);
  assert.equal(fractionsValid({ worked: -0.5, leave: 0, absent: 0 }), false);
  assert.equal(fractionsValid({ worked: 0.5, leave: 0.5, absent: 0.5 }), false);
  assert.equal(fractionsValid(null), false);
});

const cleanDay = (overrides = {}) => ({
  date: '2026-09-14',
  bucket: 'PRESENT',
  fractions: { worked: 1, leave: 0, absent: 0 },
  exceptions: [],
  ot: null,
  sessionOpen: false,
  hasSession: true,
  calendarPrimary: 'WORK_DAY',
  approvedOtMinutes: 0,
  compOffDays: 0,
  ...overrides,
});

test('31.11 clean day validates silently; non-applicable skipped', () => {
  assert.deepEqual(validateDay({ day: cleanDay() }), []);
  assert.deepEqual(validateDay({ day: null }), [
    { code: FINALIZATION_ISSUE.INVALID_PROJECTION, severity: 'BLOCKER' },
  ]);
  assert.deepEqual(validateDay({ day: cleanDay({ sessionOpen: true }), applicable: false }), []);
});

test('31.11 blockers: session/punch/correction/leave/OT/fractions', () => {
  const codes = (day) => validateDay({ day }).map((issue) => issue.code);
  assert.ok(codes(cleanDay({ sessionOpen: true })).includes('OPEN_SESSION'));
  assert.ok(codes(cleanDay({ exceptions: ['MISSING_PUNCH'] })).includes('MISSING_PUNCH'));
  assert.ok(codes(cleanDay({ exceptions: ['REGULARIZATION_PENDING'] })).includes('REGULARIZATION_PENDING'));
  assert.ok(codes(cleanDay({ exceptions: ['ATTENDANCE_ON_LEAVE'] })).includes('ATTENDANCE_ON_LEAVE'));
  assert.ok(codes(cleanDay({ ot: { status: 'PENDING' } })).includes('PENDING_OT'));
  assert.ok(codes(cleanDay({ fractions: { worked: 1, leave: 1, absent: 0 } })).includes('INVALID_FRACTIONS'));
  assert.ok(codes(cleanDay({ approvedOtMinutes: 30, compOffDays: 1 })).includes('DOUBLE_BENEFIT'));
  assert.ok(codes(cleanDay({ bucket: 'UNRESOLVED' })).includes('UNRESOLVED_DAY'));
  // No-schedule-setup fallback: unresolved days do not block.
  assert.deepEqual(validateDay({ day: cleanDay({ bucket: 'UNRESOLVED' }), hasScheduleSetup: false }), []);
  assert.equal(effectiveBucket({ bucket: 'UNRESOLVED', hasScheduleSetup: false }), 'ABSENT');
  assert.equal(effectiveBucket({ bucket: 'UNRESOLVED', hasScheduleSetup: true }), 'UNRESOLVED');
});

test('31.11 warnings never block', () => {
  const issues = validateDay({
    day: cleanDay({ exceptions: ['LATE_ARRIVAL', 'EARLY_EXIT'], compOffDays: 1 }),
  });
  assert.ok(issues.length === 3);
  assert.ok(issues.every((issue) => !isBlocker(issue)));
  const workedHoliday = validateDay({
    day: cleanDay({ calendarPrimary: 'HOLIDAY', bucket: 'HOLIDAY' }),
  });
  assert.ok(workedHoliday.some((issue) => issue.code === 'WORKED_HOLIDAY'));
  assert.equal(readinessOf(issues).ready, true);
  assert.equal(
    readinessOf([{ code: 'MISSING_PUNCH' }]).ready,
    false,
  );
});

// ── §54 pure: gates ────────────────────────────────────────────

test('31.11 gates allow the recalculable path, refuse the irreversible', () => {
  const open = payrollGates({});
  assert.equal(open.reopen.allowed, true);
  assert.equal(open.finalize.allowed, true);
  assert.equal(open.send.allowed, true);

  const calculated = payrollGates({ runStatus: 'CALCULATED', reviewStatus: 'UNDER_REVIEW' });
  assert.equal(calculated.reopen.allowed, true);

  const locked = payrollGates({ periodStatus: 'LOCKED' });
  assert.equal(locked.reopen.allowed, true);
  assert.equal(locked.finalize.allowed, true);
  assert.equal(locked.send.allowed, false);

  assert.equal(payrollGates({ periodStatus: 'SENT_TO_PAYROLL' }).reopen.allowed, false);
  assert.equal(payrollGates({ runStatus: 'CALCULATING' }).finalize.allowed, false);
  assert.equal(payrollGates({ reviewStatus: 'LOCKED' }).reopen.allowed, false);
  assert.equal(payrollGates({ reviewStatus: 'PENDING_FINANCE_APPROVAL' }).reopen.allowed, false);
  assert.equal(payrollGates({ reviewStatus: 'APPROVED' }).reopen.allowed, false);
  assert.equal(payrollGates({ paymentBatchStatus: 'READY' }).reopen.allowed, false);
  assert.equal(payrollGates({ paymentBatchStatus: 'PAID' }).finalize.allowed, false);
  assert.equal(payrollGates({ anyEmployeePaid: true }).send.allowed, false);
  assert.equal(payrollGates({ anyPayslipReleased: true }).reopen.allowed, false);
  // Benign payment states do not block.
  assert.equal(payrollGates({ paymentBatchStatus: 'DRAFT' }).reopen.allowed, true);
  assert.equal(payrollGates({ paymentBatchStatus: 'FAILED' }).reopen.allowed, true);
  assert.equal(payrollGates({ reviewStatus: 'REOPENED' }).reopen.allowed, true);
});

// ── §54 pure: snapshot derivation + auto mapping ───────────────

test('31.11 snapshot derivation aggregates scoped days', () => {
  const body = deriveEmployeeSnapshot({
    days: [
      cleanDay({ date: '2026-09-14', scheduledWorkingDay: true, workMode: 'OFFICE', workedMinutes: 480, breakMinutes: 30 }),
      cleanDay({
        date: '2026-09-13', bucket: 'LEAVE', fractions: { worked: 0, leave: 1, absent: 0 },
        hasSession: false, scheduledWorkingDay: true, workMode: null,
        calendar: { leave: { type: 'CASUAL', leaveId: 'L1' } },
      }),
    ],
  });
  assert.equal(body.scheduledWorkingDays, 2);
  assert.equal(body.scopedDays, 2);
  assert.deepEqual(body.equivalents, { worked: 1, leave: 1, absent: 0 });
  assert.equal(body.dayCounts.present, 1);
  assert.equal(body.dayCounts.leave, 1);
  assert.equal(body.leaveUnitsByType.CASUAL, 1);
  assert.deepEqual(body.leaveIds, ['L1']);
  assert.equal(body.workedMinutes, 480);
  assert.equal(body.days.length, 2);
  const total = aggregateMonth([body, body]);
  assert.equal(total.employees, 2);
  assert.equal(total.absentUnits, 0);
  assert.equal(total.workedUnits, 2);
});

test('31.11 auto mapping is leave-aware; comp-off never maps to OT', () => {
  const auto = buildAutoFromSnapshot({
    snapshot: {
      scheduledWorkingDays: 22,
      equivalents: { worked: 18, leave: 3, absent: 1 },
      dayCounts: { halfDay: 0 },
      leaveUnitsByType: { CASUAL: 2, SICK: 1, EARNED: 0, OTHER: 0 },
      lateDays: 2,
      approvedOtMinutes: 90,
      compOffDays: 1,
      overnightScheduledDays: 1,
      workedOnWeeklyOffDays: 2,
      workedOnHolidayDays: 0,
    },
    otPolicy: { enabled: true, basis: 'HOURLY', multiplier: 2 },
  });
  assert.equal(auto.workingDays, 22);
  assert.equal(auto.presentDays, 18);
  assert.equal(auto.absentDays, 1);
  assert.equal(auto.lopDays, 1);
  assert.equal(auto.lopSource, 'ATTENDANCE');
  assert.equal(auto.paidLeaveDays, 3);
  assert.equal(auto.leaveBreakdown.SICK, 1);
  assert.equal(auto.otMinutes, 90);
  assert.equal(auto.otHours, 1.5);
  assert.equal(auto.otPolicy.multiplier, 2);
  assert.equal(auto.nightShiftCount, 1);
  assert.equal(auto.weekendShiftCount, 2);
  const dumped = JSON.stringify(auto).toLowerCase();
  for (const token of ['amount', 'netpay', 'salary', 'rate']) {
    assert.ok(!dumped.includes(token), `money token leaked: ${token}`);
  }
});

test('31.11 fingerprint is deterministic over facts, blind to order', () => {
  const a = { employeeId: 'e1', body: { workedMinutes: 480 } };
  const b = { employeeId: 'e2', body: { workedMinutes: 60 } };
  assert.equal(fingerprintOf([a, b]), fingerprintOf([b, a]));
  assert.notEqual(fingerprintOf([a, b]), fingerprintOf([a]));
  assert.equal(fingerprintOf([a, b]).length, 64);
});

// ── §55 status (GET never mutates) ─────────────────────────────

test('31.11 status returns virtual OPEN without creating rows', async () => {
  const { deps, stores } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const status = await getFinalizationStatus({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  assert.equal(status.status, 'OPEN');
  assert.equal(status.currentVersion, 0);
  assert.deepEqual(status.versions, []);
  assert.equal(stores.periods.length, 0);
  await assert.rejects(
    getFinalizationStatus({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: 'bad', deps }),
    /YYYY-MM/,
  );
});

// ── §55 validate: clean month + scope ──────────────────────────

test('31.11 clean month validates ready with elapsed scope', async () => {
  const { deps } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const report = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  assert.equal(report.scopeThrough, '2026-09-14');
  assert.equal(report.employees, 1);
  assert.equal(report.hasScheduleSetup, false);
  assert.deepEqual(report.readiness, { ready: true, blockers: 0, warnings: 0, total: 0 });
  const preview = await previewFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  // Sep 1–14: 10 workdays (absent fallback) + 4 weekend days.
  assert.equal(preview.summary.absentUnits, 10);
  assert.equal(preview.summary.scheduledWorkingDays, 10);
  assert.equal(preview.summary.scopedDays, 14);
});

test('31.11 today and future days stay out of scope', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-15', {
      punchIn: dt('2026-09-15T03:30:00'), liveState: 'WORKING', workMinutes: 60,
    })],
  });
  const report = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  assert.equal(report.readiness.ready, true);
  assert.equal(report.scopeThrough, '2026-09-14');
});

// ── §55 population: joiners, exits, inactive ───────────────────

test('31.11 joiner gets no pre-joining absence', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A, { dateOfJoining: new Date('2026-09-10T00:00:00.000Z') })],
  });
  const preview = await previewFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  // Elapsed 14 days; pre-joining Sep 1–9 (9 days); scoped Sep 10–14.
  assert.equal(preview.summary.scopedDays, 5);
  assert.equal(preview.summary.absentUnits, 3);
  assert.equal(preview.summary.scheduledWorkingDays, 3);
});

test('31.11 approved exit cuts the window at the last working day', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    resignations: [{
      _id: 'res1', companyId: COMPANY_A, user: U_REP1, status: 'APPROVED',
      lastWorkingDate: new Date('2026-09-10T00:00:00.000Z'),
    }],
  });
  const preview = await previewFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  assert.equal(preview.summary.scopedDays, 10);
});

test('31.11 inactive users stay out of the population', async () => {
  const { deps } = buildDeps({
    users: [
      userDoc(U_REP1, COMPANY_A),
      userDoc(U_REP2, COMPANY_A, { status: 'INACTIVE' }),
    ],
  });
  const report = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  assert.equal(report.employees, 1);
});

// ── §55 validate: blocker surfacing ────────────────────────────

test('31.11 each blocker surfaces with identity + workflow', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A, { name: 'Riya Shah' })],
    controls: [
      controlDoc(U_REP1, '2026-09-10', { punchIn: dt('2026-09-10T03:30:00'), workMinutes: 60 }),
      controlDoc(U_REP1, '2026-09-11', {
        punchIn: dt('2026-09-11T03:30:00'), punchOut: dt('2026-09-11T12:30:00'), workMinutes: 480,
      }),
    ],
    leaves: [{
      _id: '700000000000000000000001', companyId: COMPANY_A, user: U_REP1,
      status: 'APPROVED', type: 'CASUAL', startDate: '2026-09-11', endDate: '2026-09-11',
    }],
    regs: [{
      _id: 'r1', companyId: COMPANY_A, user: U_REP1, attendanceDate: '2026-09-10',
      type: 'CLOCK_OUT_TIME_CORRECTION', status: 'PENDING',
    }],
    ots: [{
      _id: 'o1', companyId: COMPANY_A, user: U_REP1, attendanceDate: '2026-09-09',
      type: 'OVERTIME', status: 'PENDING', recordedMinutes: 60, eligibleMinutes: 60, requestedMinutes: 60,
    }],
  });
  const report = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  assert.equal(report.readiness.ready, false);
  const codes = report.blockers.map((issue) => issue.code);
  assert.ok(codes.includes('MISSING_PUNCH'));
  assert.ok(codes.includes('REGULARIZATION_PENDING'));
  assert.ok(codes.includes('ATTENDANCE_ON_LEAVE'));
  assert.ok(codes.includes('PENDING_OT'));
  const first = report.blockers[0];
  assert.equal(first.employeeName, 'Riya Shah');
  assert.ok(first.workflow);
  assert.ok(report.blockers.every((issue) => !('reason' in issue) && !('reasonText' in issue)));
});

test('31.11 past open session blocks; warnings do not', async () => {
  const warnDeps = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-11', {
      punchIn: dt('2026-09-11T04:00:00'), punchOut: dt('2026-09-11T12:30:00'),
      workMinutes: 450, lateMinutes: 30,
    })],
  });
  const warned = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: warnDeps.deps,
  });
  assert.equal(warned.readiness.ready, true);
  assert.equal(warned.readiness.warnings, 1);

  const openDeps = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-11', {
      punchIn: dt('2026-09-11T03:30:00'), liveState: 'WORKING', workMinutes: 60,
    })],
  });
  const opened = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: openDeps.deps,
  });
  assert.equal(opened.readiness.ready, false);
  assert.ok(opened.blockers.some((issue) => issue.code === 'OPEN_SESSION'));
});

test('31.11 unresolved day blocks only when schedule setup exists', async () => {
  const shift = {
    _id: '500000000000000000000001', companyId: COMPANY_A, name: 'Day',
    startTime: '09:00', endTime: '18:00', isActive: true,
  };
  const withSetup = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)], shifts: [shift] });
  const blocked = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: withSetup.deps,
  });
  assert.equal(blocked.hasScheduleSetup, true);
  assert.equal(blocked.readiness.ready, false);
  assert.ok(blocked.blockers.some((issue) => issue.code === 'UNRESOLVED_DAY'));
});

// ── §55 finalize ─────────────────────────────────────────────

test('31.11 finalize persists v1 snapshots + summary + audit', async () => {
  const { deps, audits, stores } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-14', {
      punchIn: dt('2026-09-14T03:30:00'), punchOut: dt('2026-09-14T12:30:00'), workMinutes: 480,
    })],
  });
  const result = await finalizeMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps,
  });
  assert.equal(result.version, 1);
  assert.equal(result.status, 'FINALIZED');
  assert.equal(result.fingerprint.length, 64);
  assert.equal(stores.snapshots.length, 1);
  const snap = stores.snapshots[0];
  assert.equal(snap.version, 1);
  assert.equal(snap.isCurrent, true);
  assert.equal(snap.policyVersion, 4);
  assert.equal(snap.equivalents.worked, 1);
  assert.equal(snap.days.length, 14);
  assert.equal(stores.periods[0].status, 'FINALIZED');
  assert.equal(stores.periods[0].versions.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'ATTENDANCE_FINALIZED');
  assert.ok(!JSON.stringify(audits[0]).includes('User 0002'));
});

test('31.11 finalize revalidates: frontend cannot fake readiness', async () => {
  const { deps, stores } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-10', { punchIn: dt('2026-09-10T03:30:00') })],
  });
  await assert.rejects(
    finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, ready: true, deps }),
    /blocker\(s\) must be resolved/,
  );
  assert.equal(stores.snapshots.length, 0);
  assert.equal(stores.periods[0].status, 'OPEN');
  assert.equal(stores.periods[0].currentVersion, 0);
});

test('31.11 finalize refuses months with no elapsed days', async () => {
  const { deps } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  await assert.rejects(
    finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: '2026-10', deps }),
    /no elapsed days/,
  );
});

test('31.11 finalize retry after success is an idempotent no-op', async () => {
  const built = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const first = await finalizeMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  const second = await finalizeMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  assert.equal(first.version, 1);
  assert.equal(second.alreadyFinalized, true);
  assert.equal(second.version, 1);
  assert.equal(built.stores.snapshots.length, 1);
  assert.equal(built.audits.filter((row) => row.action === 'ATTENDANCE_FINALIZED').length, 1);
});

test('31.11 stale FINALizing claim resumes the same version', async () => {
  const built = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    periods: [{
      _id: 'p1', companyId: COMPANY_A, month: SEP, status: 'FINALIZING',
      currentVersion: 0, claimedVersion: 1,
      claimedAt: new Date(TUE_10AM.getTime() - 60 * 60 * 1000),
      claimedBy: U_HR, versions: [],
    }],
  });
  const result = await finalizeMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  assert.equal(result.version, 1);
  assert.equal(built.stores.snapshots.length, 1);
});

test('31.11 fresh Finalizing claim rejects a second finalizer', async () => {
  const built = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    periods: [{
      _id: 'p1', companyId: COMPANY_A, month: SEP, status: 'FINALIZING',
      currentVersion: 0, claimedVersion: 1,
      claimedAt: new Date(TUE_10AM.getTime() - 60 * 1000),
      claimedBy: U_HR, versions: [],
    }],
  });
  await assert.rejects(
    finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps }),
    /already in progress/,
  );
});

test('31.11 concurrent finalize attempts yield one current version', async () => {
  const built = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const attempt = () => finalizeMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  const outcomes = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = outcomes.filter((row) => row.status === 'fulfilled');
  const rejected = outcomes.filter((row) => row.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason?.message || '', /already in progress|already finalized/i);
  assert.equal(built.stores.snapshots.length, 1);
  assert.equal(built.stores.periods.length, 1);
  assert.equal(built.stores.periods[0].currentVersion, 1);
});

// ── §55 send to payroll ────────────────────────────────────────

const finalizedSetup = (overrides = {}) => buildDeps({
  users: [userDoc(U_REP1, COMPANY_A), userDoc(U_REP2, COMPANY_A)],
  ...overrides,
});

test('31.11 send syncs snapshot auto, preserves HR entries', async () => {
  const built = finalizedSetup({
    inputs: [{
      _id: 'i1', companyId: COMPANY_A, month: SEP, employeeId: U_REP1,
      auto: { workingDays: 0 }, status: 'PENDING',
      entries: [{ entryId: 'e1', type: 'BONUS_PERFORMANCE', amount: 5000, reason: 'Star' }],
      remarks: 'HR note',
    }],
  });
  await finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  const sent = await sendToPayroll({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  assert.equal(sent.status, 'SENT_TO_PAYROLL');
  assert.equal(sent.syncedEmployees, 2);
  assert.equal(built.stores.inputs.length, 2);
  const kept = built.stores.inputs.find((row) => String(row.employeeId) === U_REP1);
  assert.equal(kept.auto.workingDays, 10);
  assert.equal(kept.auto.absentDays, 10);
  assert.equal(kept.auto.lopDays, 10);
  assert.equal(kept.auto.lopSource, 'ATTENDANCE');
  assert.equal(kept.auto.attendanceSource.version, 1);
  assert.ok(kept.auto.attendanceSource.syncedAt);
  assert.deepEqual(kept.entries, [{ entryId: 'e1', type: 'BONUS_PERFORMANCE', amount: 5000, reason: 'Star' }]);
  assert.equal(kept.remarks, 'HR note');
  assert.equal(kept.status, 'PENDING');
  assert.equal(built.cacheKeys.length, 1);
  assert.match(built.cacheKeys[0], /payroll-inputs/);
  const dumped = JSON.stringify(built.stores.inputs).toLowerCase();
  assert.ok(!dumped.includes('netpay'));
});

test('31.11 send is idempotent; resend makes no writes', async () => {
  const calls = [];
  const built = finalizedSetup({ counter: (model, op) => calls.push(`${model}:${op}`) });
  await finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  await sendToPayroll({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  const writesAfterFirst = calls.filter((call) => call === 'Input:updateOne').length;
  assert.equal(writesAfterFirst, 2);
  const again = await sendToPayroll({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  assert.equal(again.alreadySent, true);
  assert.equal(calls.filter((call) => call === 'Input:updateOne').length, 2);
  assert.equal(built.audits.filter((row) => row.action === 'ATTENDANCE_SENT_TO_PAYROLL').length, 1);
});

test('31.11 send refuses before finalize + unwritable periods', async () => {
  const fresh = finalizedSetup();
  await assert.rejects(
    sendToPayroll({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: fresh.deps }),
    /not finalized/,
  );
  const locked = finalizedSetup({ payrollPeriod: { _id: 'pp1', companyId: COMPANY_A, month: SEP, status: 'LOCKED' } });
  await finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: locked.deps });
  await assert.rejects(
    sendToPayroll({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: locked.deps }),
    /LOCKED/,
  );
  const sent = finalizedSetup({ payrollPeriod: { _id: 'pp1', companyId: COMPANY_A, month: SEP, status: 'SENT_TO_PAYROLL' } });
  await assert.rejects(
    finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: sent.deps }),
    /SENT_TO_PAYROLL/,
  );
});

test('31.11 partial sync failure stays FINALIZED and resumes', async () => {
  const built = finalizedSetup({ failInputSyncFor: [U_REP2] });
  await finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  await assert.rejects(
    sendToPayroll({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps }),
    /incomplete/,
  );
  assert.equal(built.stores.periods[0].status, 'FINALIZED');
  assert.match(built.stores.periods[0].lastSyncError, /1 employee/);
  // Repair the world (fresh deps, same stores) and retry — the
  // upserts resume without duplicating the synced employee.
  const healed = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A), userDoc(U_REP2, COMPANY_A)],
    periods: built.stores.periods,
    snapshots: built.stores.snapshots,
    inputs: built.stores.inputs,
  });
  const done = await sendToPayroll({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: healed.deps,
  });
  assert.equal(done.status, 'SENT_TO_PAYROLL');
  assert.equal(healed.stores.inputs.length, 2);
  assert.equal(healed.stores.periods[0].lastSyncError, '');
});

test('31.11 tampered snapshots fail the integrity check', async () => {
  const built = finalizedSetup();
  await finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  built.stores.snapshots[0].workedMinutes = 99999;
  await assert.rejects(
    sendToPayroll({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps }),
    /integrity check failed/,
  );
});

// ── §55 reopen ─────────────────────────────────────────────────

test('31.11 reopen needs a reason + a finalized month', async () => {
  const built = finalizedSetup();
  await assert.rejects(
    reopenMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, reason: '', deps: built.deps }),
    /reason is required/,
  );
  await assert.rejects(
    reopenMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, reason: 'fix', deps: built.deps }),
    /not finalized/,
  );
});

test('31.11 reopen → correct → v2 preserves v1', async () => {
  const built = finalizedSetup();
  await finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  await sendToPayroll({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  const reopened = await reopenMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, reason: 'Missing punch approved late', deps: built.deps,
  });
  assert.equal(reopened.status, 'REOPENED');
  assert.equal(built.stores.periods[0].versions[0].reopenReason, 'Missing punch approved late');
  // Correction lands in live attendance, then v2 finalizes.
  built.deps.AttendanceModel._store.push(controlDoc(U_REP1, '2026-09-14', {
    punchIn: dt('2026-09-14T03:30:00'), punchOut: dt('2026-09-14T12:30:00'), workMinutes: 480,
  }));
  const v2 = await finalizeMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  assert.equal(v2.version, 2);
  assert.equal(built.stores.periods[0].versions.length, 2);
  const v1docs = built.stores.snapshots.filter((row) => row.version === 1);
  const v2docs = built.stores.snapshots.filter((row) => row.version === 2);
  assert.equal(v1docs.length, 2);
  assert.equal(v2docs.length, 2);
  assert.ok(v1docs.every((row) => row.isCurrent === false));
  assert.ok(v2docs.every((row) => row.isCurrent === true));
  assert.equal(v1docs.find((row) => String(row.employeeId) === U_REP1).equivalents.worked, 0);
  assert.equal(v2docs.find((row) => String(row.employeeId) === U_REP1).equivalents.worked, 1);
  const resent = await sendToPayroll({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  assert.equal(resent.version, 2);
  const input = built.stores.inputs.find((row) => String(row.employeeId) === U_REP1);
  assert.equal(input.auto.presentDays, 1);
  assert.equal(input.auto.attendanceSource.version, 2);
});

// ── §55 reopen gates ───────────────────────────────────────────

test('31.11 irreversible payroll states refuse reopen', async () => {
  const scenarios = [
    [{ review: { _id: 'r', companyId: COMPANY_A, month: SEP, status: 'APPROVED' } }, /reopen it in payroll/],
    [{ batches: [{ _id: 'b', companyId: COMPANY_A, month: SEP, status: 'PAID' }] }, /payment batch/],
    [{ payments: [{ _id: 'p', companyId: COMPANY_A, month: SEP, status: 'PAID' }] }, /already paid/],
    [{ payslips: [{ _id: 's', companyId: COMPANY_A, month: SEP, status: 'EMAILED' }] }, /already released/],
    [{ payrollPeriod: { _id: 'pp1', companyId: COMPANY_A, month: SEP, status: 'SENT_TO_PAYROLL' } }, /SENT_TO_PAYROLL/],
  ];
  for (const [extra, pattern] of scenarios) {
    const built = finalizedSetup(extra);
    const period = {
      _id: 'p1', companyId: COMPANY_A, month: SEP, status: 'SENT_TO_PAYROLL',
      currentVersion: 1,
      versions: [{ version: 1, finalizedAt: TUE_10AM, finalizedBy: U_HR, fingerprint: 'x', summary: {} }],
    };
    built.deps.AttendancePeriodModel._store.push(period);
    await assert.rejects(
      reopenMonth({
        companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, reason: 'fix', deps: built.deps,
      }),
      pattern,
    );
  }
});

test('31.11 recalculable payroll allows reopen; running run blocks', async () => {
  const ok = finalizedSetup({
    run: { _id: 'run1', companyId: COMPANY_A, month: SEP, status: 'CALCULATED' },
    review: { _id: 'rev1', companyId: COMPANY_A, month: SEP, status: 'UNDER_REVIEW' },
  });
  ok.deps.AttendancePeriodModel._store.push({
    _id: 'p1', companyId: COMPANY_A, month: SEP, status: 'SENT_TO_PAYROLL',
    currentVersion: 1,
    versions: [{ version: 1, finalizedAt: TUE_10AM, finalizedBy: U_HR, fingerprint: 'x', summary: {} }],
  });
  const reopened = await reopenMonth({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, reason: 'fix before recalculation', deps: ok.deps,
  });
  assert.equal(reopened.status, 'REOPENED');

  const busy = finalizedSetup({
    run: { _id: 'run1', companyId: COMPANY_A, month: SEP, status: 'CALCULATING' },
  });
  await assert.rejects(
    finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: busy.deps }),
    /run is in progress/,
  );
});

test('31.11 reopen from OPEN is refused by the transition table', async () => {
  const built = finalizedSetup();
  built.deps.AttendancePeriodModel._store.push({
    _id: 'p1', companyId: COMPANY_A, month: SEP, status: 'OPEN', currentVersion: 0, versions: [],
  });
  await assert.rejects(
    reopenMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, reason: 'x', deps: built.deps }),
    /cannot move from OPEN/,
  );
});

// ── §55 tenancy ────────────────────────────────────────────────

test('31.11 tenant B rows never leak into tenant A finalization', async () => {
  const built = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A), userDoc(U_B, COMPANY_B, { name: 'Bee Other' })],
    controls: [
      controlDoc(U_REP1, '2026-09-14', {
        punchIn: dt('2026-09-14T03:30:00'), punchOut: dt('2026-09-14T12:30:00'), workMinutes: 480,
      }),
      { ...controlDoc(U_B, '2026-09-14'), companyId: COMPANY_B, workMinutes: 999 },
    ],
  });
  const report = await validateFinalization({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps,
  });
  assert.equal(report.employees, 1);
  await finalizeMonth({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  await sendToPayroll({ companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), month: SEP, deps: built.deps });
  assert.ok(built.stores.snapshots.every((row) => String(row.companyId) === COMPANY_A));
  assert.ok(built.stores.inputs.every((row) => String(row.companyId) === COMPANY_A));
  assert.ok(!JSON.stringify(built.stores).includes('Bee Other'));
  assert.ok(!JSON.stringify(built.stores.snapshots).includes('999'));
});

// ── 29.5 legacy-import guard ───────────────────────────────────

const tiny29Deps = ({ attendanceStatus = null } = {}) => ({
  PayrollPeriodModel: fakeCollection({
    rows: [{ _id: 'pp1', companyId: COMPANY_A, month: SEP, status: 'COLLECTING_INPUTS', workingDays: 0 }],
    name: 'P29',
  }),
  EmployeeMonthlyInputModel: fakeCollection({ rows: [], name: 'I29' }),
  EmployeePayrollProfileModel: fakeCollection({ rows: [], name: 'Prof29' }),
  UserModel: fakeCollection({ rows: [userDoc(U_REP1, COMPANY_A)], name: 'U29' }),
  AttendanceModel: null,
  LeaveModel: null,
  HolidayModel: null,
  ShiftModel: null,
  PayrollSetupModel: null,
  AttendancePeriodModel: attendanceStatus
    ? fakeCollection({
      rows: [{ _id: 'ap1', companyId: COMPANY_A, month: SEP, status: attendanceStatus }],
      name: 'AP29',
    })
    : null,
});

test('31.11 legacy import refuses once attendance is SENT', async () => {
  const service = makeMonthlyInputService(tiny29Deps({ attendanceStatus: 'SENT_TO_PAYROLL' }));
  await assert.rejects(
    service.importAutomatic({ companyId: COMPANY_A, month: SEP, actor: actor(U_HR, 'HR_MANAGER') }),
    /finalized and sent to payroll/,
  );
});

test('31.11 legacy import still works before attendance send', async () => {
  const service = makeMonthlyInputService(tiny29Deps({ attendanceStatus: 'FINALIZED' }));
  const result = await service.importAutomatic({
    companyId: COMPANY_A, month: SEP, actor: actor(U_HR, 'HR_MANAGER'),
  });
  assert.equal(result.imported, 1);
});

// ── hygiene ────────────────────────────────────────────────────

test('31.11 source hygiene: no money, no force flags, no payroll lock', () => {
  const service = readSource('src/services/attendance/attendanceFinalizationService.js');
  const rules = readSource('src/services/attendance/attendanceFinalizationRules.js');
  const controller = readSource('src/controllers/attendanceFinalizationController.js');
  const blob = `${service}\n${rules}\n${controller}`;
  for (const token of [
    'force', 'skipValidation', 'adminOverride', 'bypass', 'netPay', 'grossPay',
    'calculateSalary', 'BullMQ', 'Queue(', 'startSession', 'withTransaction',
    'PayrollResultModel.create', 'PayslipModel.create', 'PayslipModel.update', 'lopDeduction',
  ]) {
    assert.ok(!blob.includes(token), `forbidden token present: ${token}`);
  }
  assert.ok(!rules.includes('mongoose') && !rules.includes('req.'));
  assert.match(service, /ATTENDANCE_FINALIZED/);
  assert.match(service, /ATTENDANCE_SENT_TO_PAYROLL/);
  assert.match(service, /ATTENDANCE_REOPENED/);
});

test('31.11 routes + permissions mount the six guarded endpoints', () => {
  const routes = readSource('src/routes/attendanceRoutes.js');
  assert.match(routes, /finalization\/:month\/validate/);
  assert.match(routes, /finalization\/:month\/preview/);
  assert.match(routes, /finalization\/:month\/finalize/);
  assert.match(routes, /finalization\/:month\/send-to-payroll/);
  assert.match(routes, /finalization\/:month\/reopen/);
  assert.match(routes, /ATTENDANCE_FINALIZATION_READ/);
  assert.match(routes, /ATTENDANCE_FINALIZATION_MANAGE/);
  assert.match(routes, /ATTENDANCE_FINALIZATION_REOPEN/);
  const registry = readSource('src/utils/permissionRegistry.js');
  assert.match(registry, /ATTENDANCE_FINALIZATION", \["READ", "MANAGE", "REOPEN"\]/);
  const permService = readSource('src/utils/permissionService.js');
  assert.match(permService, /SYSTEM_PERMISSION_VERSION = 35/);
});
