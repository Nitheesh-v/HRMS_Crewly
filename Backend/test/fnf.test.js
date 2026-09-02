/**
 * PHASE 29.11 — Final Settlement (F&F), Resignation Recovery & Exit Payroll
 *
 * Hermetic: fake models, a fake cache, and fake audit / notify / dispatch /
 * pdf seams. No MongoDB, no Redis, no BullMQ, no SMTP.
 *
 * The suite proves the things that are expensive to discover in production:
 *   · §7    the last working day decides the payable days — HR never types it
 *   · §8    leave encashment is shown transparently and capped
 *   · §10   gratuity needs five years and says why when it does not apply
 *   · §12   notice COMPLETED / BUYOUT / WAIVED all behave differently
 *   · §14   CLOSED is immutable; every other move is enforced
 *   · §15   Finance approval is unreachable until the checklist is complete
 *   · §16   a rejection returns to HR Review and needs remarks
 *   · §18   an employee reaches their own settlement and nothing else
 *   · §20   the dashboard cache is dropped on every status change
 *   · §21   queue payloads carry references only — never a rupee
 *   · §23   every action lands in the audit trail with previous + new status
 *   · §3/§24 another tenant's settlement is unreachable
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKLIST_ITEMS,
  FNF_RULES,
  NOTICE_DECISION_LABELS,
  PAYABLE_TYPE_LABELS,
  FNF_AUDIT_ACTIONS,
  RECOVERY_TYPE_LABELS,
  SETTLEMENT_STATUSES,
  SETTLEMENT_TRANSITIONS,
  buildSettlementNumber,
  canTransitionSettlement,
  checklistComplete,
  checklistProgress,
  computeGratuity,
  computeLeaveEncashment,
  computeNoticeRecovery,
  computePayableDays,
  computePendingSalary,
  daysBetween,
  filterSettlements,
  isSettlementEditable,
  isSettlementLocked,
  money,
  registerRows,
  REGISTER_HEADERS,
  settlementKpis,
  settlementTotals,
  statementFilename,
  toEmployeeSettlementView,
  validateRecoveryItem,
} from '../src/services/payroll/fnfRules.js';
import { makeFnfService } from '../src/services/payroll/fnfService.js';
import {
  validateFnfRegisterPayload,
  validateFnfStatementPayload,
} from '../src/services/payroll/fnfDispatcher.js';
import { buildXlsx, toCsv } from '../src/services/payroll/payrollPaymentRules.js';
import { buildFnfStatementPdf } from '../src/utils/fnfPdf.js';

// ── fake model ─────────────────────────────────────────────────────────────

const oid = (seed) => `64b7f9c2e4b0a1b2c3d4e${String(seed).padStart(3, '0')}`; // 24 hex chars

// Mongo resolves dotted paths; the settlement's unique-per-exit index is on
// 'exit.resignationId', so the fake has to as well.
const pathValue = (row, path) =>
  String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), row);

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = pathValue(row, key);
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
      if (condition.$ne !== undefined) return String(value) !== String(condition.$ne);
      // Range operators are what the leave-balance query uses.
      if (condition.$gte !== undefined && !(String(value) >= String(condition.$gte))) return false;
      if (condition.$gt !== undefined && !(String(value) > String(condition.$gt))) return false;
      if (condition.$lte !== undefined && !(String(value) <= String(condition.$lte))) return false;
      if (condition.$lt !== undefined && !(String(value) < String(condition.$lt))) return false;
      if ('$gte' in condition || '$gt' in condition || '$lte' in condition || '$lt' in condition) return true;
      return String(value) === String(condition);
    }
    if (condition instanceof Date) return String(value) === String(condition);
    return String(value) === String(condition);
  });

const applyUpdate = (row, update = {}) => {
  Object.entries(update.$set || {}).forEach(([key, value]) => {
    if (key.includes('.')) {
      const [head, tail] = key.split('.');
      row[head] = { ...(row[head] || {}), [tail]: value };
    } else {
      row[key] = value;
    }
  });
  Object.entries(update.$inc || {}).forEach(([key, delta]) => {
    const path = key.split('.');
    if (path.length === 1) {
      row[key] = Number(row[key] || 0) + Number(delta);
    } else {
      row[path[0]] = { ...(row[path[0]] || {}) };
      row[path[0]][path[1]] = Number(row[path[0]][path[1]] || 0) + Number(delta);
    }
  });
};

const makeFakeModel = (defaults = {}) => {
  const rows = [];
  let counter = 0;

  const buildQuery = (filter, sortKey = null) => ({
    lean: async () => {
      const found = rows.filter((row) => matches(row, filter));
      if (sortKey) {
        const [field, direction] = sortKey;
        found.sort((a, b) => (direction === -1 ? String(b[field]).localeCompare(String(a[field])) : String(a[field]).localeCompare(String(b[field]))));
      }
      // Mongoose's .lean() returns detached plain objects.
      return found.map((row) => ({ ...row }));
    },
    select: () => buildQuery(filter, sortKey),
    sort: (spec) => {
      const field = Object.keys(spec || {})[0];
      return buildQuery(filter, field ? [field, spec[field]] : sortKey);
    },
    limit: () => buildQuery(filter, sortKey),
  });

  // A live document: mutating it mutates the store, and .save() is a no-op
  // that just marks the write (exactly what the service relies on).
  const asDocument = (row) =>
    Object.assign(row, {
      async save() {
        row.updatedAt = new Date();
        return row;
      },
    });

  const model = {
    rows,
    find: (filter = {}) => buildQuery(filter),
    findOne: (filter = {}) => {
      const chain = {
        lean: async () => {
          const found = rows.find((row) => matches(row, filter));
          return found ? { ...found } : null;
        },
        // .select('+binary') also has to be awaitable AND chainable: the
        // download route reads the artefact through it.
        select: () => chain,
        sort: () => chain,
        then: (resolve, reject) => (async () => {
          const found = rows.find((row) => matches(row, filter));
          return found ? asDocument(found) : null;
        })().then(resolve, reject),
        catch: (reject) => chain.then(undefined, reject),
      };
      return chain;
    },
    findById: (id) => ({
      lean: async () => {
        const found = rows.find((row) => String(row._id) === String(id));
        return found ? { ...found } : null;
      },
    }),
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    async create(doc) {
      counter += 1;
      const row = {
        _id: oid(counter + 500),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...defaults,
        ...doc,
      };
      rows.push(row);
      return asDocument(row);
    },
    async updateOne(filter, update = {}, options = {}) {
      const row = rows.find((item) => matches(item, filter));
      if (!row) {
        if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
        const inserted = await model.create({ ...(filter || {}) });
        applyUpdate(inserted, update);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update = {}, options = {}) {
      const existing = rows.find((item) => matches(item, filter));
      if (existing) {
        applyUpdate(existing, update);
        return existing;
      }
      if (!options.upsert) return null;
      const inserted = await model.create({ ...(filter || {}), ...(update.$setOnInsert || {}) });
      applyUpdate(inserted, update);
      return inserted;
    },
  };

  return model;
};

// ── fixtures ───────────────────────────────────────────────────────────────

const COMPANY = '64b7f9c2e4b0a1b2c3d4e5f6';
const OTHER_COMPANY = '64b7f9c2e4b0a1b2c3d4e999';
const MONTH = '2026-08';
const E1 = oid(1);
const E2 = oid(2);
const DEPARTMENT = oid(50);

const employee = (id, code, name, joiningDate = '2019-06-03') => ({
  _id: id,
  companyId: COMPANY,
  employeeCode: code,
  name,
  email: `${code.toLowerCase()}@crewly.test`,
  department: DEPARTMENT,
  designation: 'Senior Engineer',
  joiningDate: new Date(`${joiningDate}T00:00:00Z`),
  status: 'ACTIVE',
});

// 29.6 snapshot — the proration base. Gross 62,000 over 31 working days
// gives a daily rate of 2,000, which is the §8 example rate.
const result = (employeeId, { gross = 62000, basic = 31000, lopDays = 0 } = {}) => ({
  _id: oid(900 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  month: MONTH,
  employeeId,
  isCurrent: true,
  totals: { gross, basic, totalEarnings: gross, totalDeductions: 8000, netPay: gross - 8000 },
  attendance: { workingDays: 31, paidDays: 31 - lopDays, lopDays },
});

const profile = (employeeId, extra = {}) => ({
  _id: oid(700 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  employeeId,
  isCurrent: true,
  monthlyGross: 62000,
  statutory: {
    pan: 'ABCPD1234K',
    uan: '100123456789',
    esiNumber: '',
    pfMember: true,
    gratuityEligible: true,
  },
  tax: { regime: 'NEW', tdsApplicable: true },
  ...extra,
});

const resignation = (employeeId, { status = 'APPROVED', lwd = '2026-08-18', id = oid(80) } = {}) => ({
  _id: id,
  companyId: COMPANY,
  user: employeeId,
  status,
  reason: 'Moving on to a new opportunity',
  lastWorkingDate: new Date(`${lwd}T00:00:00Z`),
  createdAt: new Date('2026-06-18T00:00:00Z'),
  decidedAt: new Date('2026-06-20T00:00:00Z'),
  decisionNote: 'Approved',
});

// ── harness ────────────────────────────────────────────────────────────────

const buildHarness = ({
  employees = [],
  results = [],
  profiles = [],
  resignations = [],
  assets = [],
  leaves = [],
  periods = [],
  settlements = [],
} = {}) => {
  const state = {
    settlements: makeFakeModel(),
    files: makeFakeModel({ status: 'QUEUED' }),
    resignations: makeFakeModel(),
    assets: makeFakeModel(),
    leaves: makeFakeModel(),
    results: makeFakeModel(),
    periods: makeFakeModel(),
    setups: makeFakeModel(),
    profiles: makeFakeModel(),
    users: makeFakeModel(),
    companies: makeFakeModel(),
    departments: makeFakeModel(),
    audits: [],
    notifications: [],
    invalidations: [],
    dispatched: [],
  };

  employees.forEach((row) => state.users.rows.push(row));
  results.forEach((row) => state.results.rows.push(row));
  profiles.forEach((row) => state.profiles.rows.push(row));
  resignations.forEach((row) => state.resignations.rows.push(row));
  assets.forEach((row) => state.assets.rows.push(row));
  leaves.forEach((row) => state.leaves.rows.push(row));
  periods.forEach((row) => state.periods.rows.push(row));
  settlements.forEach((row) => state.settlements.rows.push(row));

  state.companies.rows.push({ _id: COMPANY, name: 'Crewly Technologies Pvt Ltd', address: 'Bengaluru', logoUrl: '' });
  state.departments.rows.push({ _id: DEPARTMENT, name: 'Engineering' });

  const cache = {
    store: new Map(),
    buildKey: ({ companyId, month = '', suffix = 'dashboard', period = '' }) =>
      `k:${companyId}:${month || 'all'}:${suffix}:${period || '-'}`,
    async getOrSet(key, { loader }) {
      if (this.store.has(key)) return { value: this.store.get(key), cache: 'HIT' };
      const value = await loader();
      this.store.set(key, value);
      return { value, cache: 'MISS' };
    },
    async invalidate(companyId, month = '') {
      state.invalidations.push({ companyId, month });
      let removed = 0;
      for (const key of [...this.store.keys()]) {
        if (key.startsWith(`k:${companyId}:`)) {
          this.store.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };

  const service = makeFnfService({
    FinalSettlementModel: state.settlements,
    FinalSettlementFileModel: state.files,
    ResignationModel: state.resignations,
    AssetModel: state.assets,
    LeaveModel: state.leaves,
    PayrollResultModel: state.results,
    PayrollPeriodModel: state.periods,
    PayrollSetupModel: state.setups,
    EmployeePayrollProfileModel: state.profiles,
    UserModel: state.users,
    CompanyModel: state.companies,
    DepartmentModel: state.departments,
    cache,
    audit: async (entry) => {
      state.audits.push(entry);
      return entry;
    },
    notify: async ({ userId, type, payload }) => {
      state.notifications.push({ userId, type, payload });
    },
    notifyRoles: async ({ permission, type, payload }) => {
      state.notifications.push({ userId: 'PERMISSION', permission, type, payload });
      return 1;
    },
    dispatchStatement: async (payload) => {
      state.dispatched.push({ kind: 'statement', payload });
      return { queued: false };
    },
    dispatchRegister: async (payload) => {
      state.dispatched.push({ kind: 'register', payload });
      return { queued: false };
    },
    renderPdf: async (options) => buildFnfStatementPdf(options),
    buildCsv: toCsv,
    buildWorkbook: buildXlsx,
    hash: (value) => `sha256:${Buffer.byteLength(value)}`,
    leaveQuota: { CASUAL: 12, SICK: 6, EARNED: 12 },
    ttlSeconds: 60,
  });

  return { service, state, cache };
};

// One employee, one approved resignation, last working day 18 Aug.
const fullHarness = (overrides = {}) =>
  buildHarness({
    employees: [employee(E1, 'CRE-001', 'Meera Iyer')],
    results: [result(E1)],
    profiles: [profile(E1)],
    resignations: [resignation(E1)],
    periods: [{ _id: oid(70), companyId: COMPANY, month: MONTH, workingDays: 31, status: 'LOCKED' }],
    // 4 approved earned-leave days this year → 8 unused of the 12-day quota.
    leaves: [{ _id: oid(71), companyId: COMPANY, user: E1, type: 'EARNED', days: 4, status: 'APPROVED', startDate: '2026-03-04' }],
    assets: [{ _id: oid(72), companyId: COMPANY, name: 'MacBook Pro 14', category: 'LAPTOP', currentHolder: E1 }],
    ...overrides,
  });

// Meera: gross 62,000 / 31 days = 2,000 a day; LWD 18 Aug → 18 payable days
// → pending salary 36,000. Unused earned leave 8 days × 2,000 = 16,000.
// Joined 2019-06-03, leaves 2026-08-18 → 7 years → gratuity
// 31,000 × 15/26 × 7 = 1,25,192.30.
const EXPECTED = {
  dailyRate: 2000,
  payableDays: 18,
  pendingSalary: 36000,
  leaveEncashment: 16000,
  gratuity: money(31000 * (15 / 26) * 7),
};

const hrActor = { _id: oid(11), name: 'Hriday HR' };
const financeActor = { _id: oid(12), name: 'Farah Finance' };
const payrollActor = { _id: oid(13), name: 'Priya Payroll' };

const fullChecklist = () => ({
  attendanceVerified: true,
  leaveVerified: true,
  assetClearanceCompleted: true,
  noticeDecisionCompleted: true,
});

// Drive a settlement all the way to Finance Approved.
const approvedSettlement = async (harness) => {
  const created = await harness.service.createSettlement({
    companyId: COMPANY,
    employeeId: E1,
    resignationId: oid(80),
    actor: payrollActor,
  });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });
  await harness.service.hrReview({
    companyId: COMPANY,
    settlementId: created.settlementId,
    checklist: fullChecklist(),
    complete: true,
    actor: hrActor,
  });
  const approved = await harness.service.financeDecision({
    companyId: COMPANY,
    settlementId: created.settlementId,
    action: 'APPROVE',
    actor: financeActor,
  });
  return { ...approved, settlementId: created.settlementId };
};

// ── §7 — the last working day decides the payable days ─────────────────────

test('§7 payable days follow the last working day, not a typed number', () => {
  // The brief's own example: August, 31 working days, last day 18 Aug → 18.
  assert.equal(computePayableDays({ month: '2026-08', workingDays: 31, lastWorkingDate: '2026-08-18' }), 18);
  // A last working day after the month end cannot exceed the month.
  assert.equal(computePayableDays({ month: '2026-08', workingDays: 22, lastWorkingDate: '2026-08-31' }), 22);
  // LOP already taken in the month reduces it.
  assert.equal(
    computePayableDays({ month: '2026-08', workingDays: 31, lastWorkingDate: '2026-08-18', lopDays: 3 }),
    15,
  );
  // No last working day yet → the full month, never zero.
  assert.equal(computePayableDays({ month: '2026-08', workingDays: 31, lastWorkingDate: '' }), 31);
  // A negative result is impossible.
  assert.equal(computePayableDays({ month: '2026-08', workingDays: 31, lastWorkingDate: '2026-08-02', lopDays: 9 }), 0);
});

test('§7 pending salary is daily rate x payable days', () => {
  const salary = computePendingSalary({ monthlyGross: 62000, workingDays: 31, payableDays: 18 });
  assert.equal(salary.dailyRate, EXPECTED.dailyRate);
  assert.equal(salary.amount, EXPECTED.pendingSalary);
  // A 30-day fallback keeps a company without a payroll period sane.
  const fallback = computePendingSalary({ monthlyGross: 60000, workingDays: 0, payableDays: 15 });
  assert.equal(fallback.dailyRate, 2000);
  assert.equal(fallback.amount, 30000);
});

// ── §8 — leave encashment ──────────────────────────────────────────────────

test('§8 leave encashment is days x daily rate, capped by policy', () => {
  const encashment = computeLeaveEncashment({ unusedDays: 8, dailyRate: 2000 });
  assert.equal(encashment.encashedDays, 8);
  assert.equal(encashment.amount, EXPECTED.leaveEncashment);
  assert.equal(encashment.capped, false);

  // The brief's arithmetic, verbatim: 8 days x Rs 2,000 = Rs 16,000.
  assert.equal(encashment.amount, 16000);

  const capped = computeLeaveEncashment({ unusedDays: 45, dailyRate: 2000, maxDays: 30 });
  assert.equal(capped.encashedDays, 30);
  assert.equal(capped.amount, 60000);
  assert.equal(capped.capped, true);
  assert.equal(capped.maxDays, FNF_RULES.leaveEncashment.maxDays);
});

// ── §10 / §11 — gratuity ───────────────────────────────────────────────────

test('§10 gratuity needs five years and explains itself when it does not apply', () => {
  const payable = computeGratuity({
    monthlyBasic: 31000,
    joiningDate: '2019-06-03',
    lastWorkingDate: '2026-08-18',
    eligible: true,
  });
  assert.equal(payable.eligible, true);
  assert.equal(payable.creditedYears, 7);
  assert.equal(payable.amount, EXPECTED.gratuity);

  // Under five years: no gratuity, and a reason the employee can read.
  const short = computeGratuity({
    monthlyBasic: 31000,
    joiningDate: '2024-01-01',
    lastWorkingDate: '2026-08-18',
    eligible: true,
  });
  assert.equal(short.eligible, false);
  assert.equal(short.amount, 0);
  assert.match(short.reason, /5 years/);

  // Eligible by service but switched off for the employee.
  const switched = computeGratuity({
    monthlyBasic: 31000,
    joiningDate: '2015-01-01',
    lastWorkingDate: '2026-08-18',
    eligible: false,
  });
  assert.equal(switched.amount, 0);
  assert.match(switched.reason, /not applicable/);

  // A part-year of six months or more counts as a full year.
  assert.equal(
    computeGratuity({ monthlyBasic: 1000, joiningDate: '2020-01-01', lastWorkingDate: '2025-08-01', eligible: true }).creditedYears,
    6,
  );
});

test('§11 net settlement is earnings minus recoveries, and a negative is flagged', () => {
  const totals = settlementTotals({
    pendingSalary: 36000,
    additionalPayables: [{ amount: 16000, source: 'SYSTEM' }, { amount: 5000, source: 'MANUAL' }],
    leaveEncashment: 16000,
    noticeRecovery: 4000,
    recoveries: [{ amount: 1500 }, { amount: 500 }],
  });

  assert.equal(totals.totalEarnings, 57000);
  assert.equal(totals.totalRecoveries, 6000);
  assert.equal(totals.netSettlement, 51000);
  // Manual additions are reported separately from the computed ones.
  assert.equal(totals.totalManualAdditional, 5000);
  assert.equal(totals.negative, false);

  const overdrawn = settlementTotals({
    pendingSalary: 1000,
    additionalPayables: [],
    noticeRecovery: 4000,
    recoveries: [],
  });
  assert.equal(overdrawn.netSettlement, -3000);
  assert.equal(overdrawn.negative, true);
});

// ── §12 — notice period ────────────────────────────────────────────────────

test('§12 notice COMPLETED, BUYOUT and WAIVED behave differently', () => {
  const base = { noticePeriodDays: 60, servedDays: 40, dailyRate: 2000 };
  const shortfall = 20;

  const completed = computeNoticeRecovery({ ...base, decision: 'COMPLETED' });
  assert.equal(completed.amount, 0);
  assert.equal(completed.shortfallDays, shortfall);

  const buyout = computeNoticeRecovery({ ...base, decision: 'BUYOUT' });
  assert.equal(buyout.amount, shortfall * 2000);
  assert.equal(buyout.waived, false);

  const waived = computeNoticeRecovery({ ...base, decision: 'WAIVED' });
  assert.equal(waived.amount, 0);
  // A waiver is recorded, not silently dropped.
  assert.equal(waived.waived, true);

  // Serving the full notice leaves nothing to recover, whatever the decision.
  const served = computeNoticeRecovery({ ...base, servedDays: 60, decision: 'BUYOUT' });
  assert.equal(served.shortfallDays, 0);
  assert.equal(served.amount, 0);

  assert.equal(NOTICE_DECISION_LABELS.BUYOUT, 'Notice Buyout');
});

test('§9 every recovery carries an amount, a reason and an approver', () => {
  assert.deepEqual(validateRecoveryItem({ type: 'ASSET', amount: 500, reason: 'Laptop not returned' }), []);
  assert.ok(validateRecoveryItem({ type: 'ASSET', amount: 0, reason: 'x' }).length);
  assert.ok(validateRecoveryItem({ type: 'ASSET', amount: 500, reason: '  ' }).length);
  assert.ok(validateRecoveryItem({ type: 'MADE_UP', amount: 500, reason: 'x' }).length);
  assert.equal(RECOVERY_TYPE_LABELS.ADVANCE_SALARY, 'Advance Salary Recovery');
  assert.equal(PAYABLE_TYPE_LABELS.LEAVE_ENCASHMENT, 'Leave Encashment');
});

// ── §14 — the lifecycle ────────────────────────────────────────────────────

test('§14 the settlement lifecycle is enforced, and CLOSED is terminal', () => {
  assert.deepEqual(SETTLEMENT_STATUSES, [
    'DRAFT', 'CALCULATED', 'HR_REVIEWED', 'FINANCE_APPROVED', 'PAID', 'CLOSED', 'REOPENED',
  ]);
  assert.ok(canTransitionSettlement('DRAFT', 'CALCULATED'));
  assert.ok(canTransitionSettlement('CALCULATED', 'HR_REVIEWED'));
  assert.ok(canTransitionSettlement('HR_REVIEWED', 'FINANCE_APPROVED'));
  assert.ok(canTransitionSettlement('FINANCE_APPROVED', 'PAID'));
  assert.ok(canTransitionSettlement('PAID', 'CLOSED'));
  assert.ok(canTransitionSettlement('CLOSED', 'REOPENED'));
  assert.ok(canTransitionSettlement('REOPENED', 'CALCULATED'));
  // A rejection returns to HR Review §16 — the state where the items are
  // editable again — and never skips a step.
  assert.ok(canTransitionSettlement('HR_REVIEWED', 'CALCULATED'));
  assert.ok(canTransitionSettlement('FINANCE_APPROVED', 'CALCULATED'));
  assert.ok(!canTransitionSettlement('DRAFT', 'PAID'));
  assert.ok(!canTransitionSettlement('CLOSED', 'CALCULATED'));
  assert.ok(!canTransitionSettlement('HR_REVIEWED', 'CLOSED'));

  assert.equal(isSettlementLocked('CLOSED'), true);
  assert.equal(isSettlementEditable('CLOSED'), false);
  assert.equal(isSettlementEditable('DRAFT'), true);
  assert.equal(isSettlementEditable('FINANCE_APPROVED'), false);
  assert.deepEqual(Object.keys(SETTLEMENT_TRANSITIONS).sort(), [...SETTLEMENT_STATUSES].sort());
});

// ── §15 — the checklist ────────────────────────────────────────────────────

test('§15 the HR checklist gates Finance approval', () => {
  const empty = { attendanceVerified: true, leaveVerified: true, assetClearanceCompleted: true, noticeDecisionCompleted: false };
  assert.equal(checklistComplete(empty), false);
  assert.equal(checklistProgress(empty).done, 3);
  assert.equal(checklistProgress(empty).percent, 75);
  assert.equal(checklistComplete(fullChecklist()), true);
  assert.deepEqual(CHECKLIST_ITEMS, [
    'attendanceVerified',
    'leaveVerified',
    'assetClearanceCompleted',
    'noticeDecisionCompleted',
  ]);
});

// ── §17 — identifiers ──────────────────────────────────────────────────────

test('§17 the settlement number is sequential and the filename is filesystem-safe', () => {
  assert.equal(buildSettlementNumber({ month: '2026-08', sequence: 1 }), 'FNF-202608-0001');
  assert.equal(buildSettlementNumber({ month: '2026-08', sequence: 245 }), 'FNF-202608-0245');
  // A zero or garbage sequence still produces a usable number.
  assert.equal(buildSettlementNumber({ month: '2026-08', sequence: 0 }), 'FNF-202608-0001');
  assert.equal(
    statementFilename({ settlementNumber: 'FNF-202608-0001', employeeName: 'Asha / Rao' }),
    'FNF-202608-0001-Asha-Rao.pdf',
  );
});

// ── §19 — KPIs and filtering ───────────────────────────────────────────────

test('§19 the dashboard KPIs count each stage and total the committed amount', () => {
  const rows = [
    { status: 'DRAFT', totals: { netSettlement: 100 } },
    { status: 'CALCULATED', totals: { netSettlement: 200 } },
    { status: 'HR_REVIEWED', totals: { netSettlement: 300 } },
    { status: 'FINANCE_APPROVED', totals: { netSettlement: 400 } },
    { status: 'PAID', totals: { netSettlement: 500 } },
    { status: 'CLOSED', totals: { netSettlement: 600 } },
  ];
  const kpis = settlementKpis({ rows });
  assert.equal(kpis.totalSettlements, 6);
  assert.equal(kpis.pendingSettlements, 2);  // DRAFT + CALCULATED
  assert.equal(kpis.hrReview, 1);
  assert.equal(kpis.financeApproval, 1);
  assert.equal(kpis.paid, 1);
  assert.equal(kpis.closed, 1);
  // A draft has no amount yet, so it is excluded from the total.
  assert.equal(kpis.totalSettlementAmount, 2000);
});

test('§19 search and department filters narrow the list', () => {
  const rows = [
    { status: 'PAID', employee: { name: 'Asha Rao', employeeCode: 'CRE-001', departmentId: DEPARTMENT } },
    { status: 'PAID', employee: { name: 'Vikram Shetty', employeeCode: 'CRE-002', departmentId: 'other' } },
    { status: 'DRAFT', employee: { name: 'Asha Rao', employeeCode: 'CRE-003', departmentId: DEPARTMENT } },
  ];
  assert.equal(filterSettlements({ rows, search: 'asha' }).length, 2);
  assert.equal(filterSettlements({ rows, search: 'CRE-002' }).length, 1);
  assert.equal(filterSettlements({ rows, status: 'PAID' }).length, 2);
  assert.equal(filterSettlements({ rows, departmentId: DEPARTMENT }).length, 2);
  assert.equal(filterSettlements({ rows, search: 'nobody' }).length, 0);
});

// ── §5 / §6 — creating from the Exit module ────────────────────────────────

test('§5/§6 a settlement is opened from an APPROVED resignation and copies the exit', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY,
    employeeId: E1,
    resignationId: oid(80),
    actor: payrollActor,
  });

  assert.equal(created.status, 'DRAFT');
  assert.equal(created.settlementNumber, 'FNF-202608-0001');
  assert.equal(created.month, MONTH);

  const detail = await harness.service.getSettlement({ companyId: COMPANY, settlementId: created.settlementId });
  assert.equal(detail.exit.lastWorkingDate, '2026-08-18');
  assert.equal(detail.exit.resignationDate, '2026-06-18');
  assert.equal(detail.exit.reason, 'Moving on to a new opportunity');
  assert.equal(detail.exit.employeeName, 'Meera Iyer');
  // §7/§8/§10 — the figures were computed at creation.
  assert.equal(detail.earnings.pendingSalary.payableDays, EXPECTED.payableDays);
  assert.equal(detail.earnings.pendingSalary.amount, EXPECTED.pendingSalary);
  assert.equal(detail.earnings.leaveEncashment.amount, EXPECTED.leaveEncashment);
  assert.equal(detail.earnings.gratuity.amount, EXPECTED.gratuity);
  assert.equal(detail.totals.negative, false);
  // §13 — the outstanding asset was picked up from the Asset module.
  assert.equal(detail.assets.length, 1);
  assert.equal(detail.assets[0].name, 'MacBook Pro 14');

  const createdAudit = harness.state.audits.find((entry) => /created/i.test(entry.action));
  assert.ok(createdAudit, 'creating a settlement is audited');
  assert.equal(String(createdAudit.companyId), COMPANY);
});

test('§5 a resignation that HR has not approved cannot be settled', async () => {
  const harness = fullHarness({ resignations: [resignation(E1, { status: 'PENDING' })] });
  await assert.rejects(
    () => harness.service.createSettlement({ companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor }),
    /approved/i,
  );
});

test('§5 one exit gets exactly one settlement', async () => {
  const harness = fullHarness();
  await harness.service.createSettlement({ companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor });
  await assert.rejects(
    () => harness.service.createSettlement({ companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor }),
    /already exists/i,
  );
});

test('§3 an employee of another company cannot be settled here', async () => {
  const harness = fullHarness();
  await assert.rejects(
    () => harness.service.createSettlement({ companyId: COMPANY, employeeId: oid(99), resignationId: oid(80), actor: payrollActor }),
    /not found/i,
  );
});

// ── §7 — calculation ───────────────────────────────────────────────────────

test('§7 recalculating moves DRAFT to CALCULATED and recomputes from the snapshot', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });

  const calculated = await harness.service.recalculate({
    companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor,
  });

  assert.equal(calculated.status, 'CALCULATED');
  assert.equal(calculated.earnings.pendingSalary.amount, EXPECTED.pendingSalary);
  assert.ok(harness.state.audits.some((entry) => /calculated/i.test(entry.action)));
  // §23 — the audit records where the settlement came from and where it went.
  const audit = harness.state.audits.find((entry) => /calculated/i.test(entry.action));
  assert.equal(audit.previousValue.status, 'DRAFT');
  assert.equal(audit.newValue.status, 'CALCULATED');
});

test('§7 LOP already taken in the month reduces the payable days', async () => {
  const harness = fullHarness({ results: [result(E1, { lopDays: 3 })] });
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  const detail = await harness.service.getSettlement({ companyId: COMPANY, settlementId: created.settlementId });

  assert.equal(detail.earnings.pendingSalary.payableDays, 15);
  assert.equal(detail.earnings.pendingSalary.amount, 30000);
});

// ── §15 — HR review ────────────────────────────────────────────────────────

test('§15 Finance approval stays closed until every checklist item is ticked', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });

  await assert.rejects(
    () => harness.service.hrReview({
      companyId: COMPANY,
      settlementId: created.settlementId,
      checklist: { attendanceVerified: true },
      complete: true,
      actor: hrActor,
    }),
    /checklist/i,
  );

  // The checklist is still saved — HR does not lose the ticks.
  const partial = await harness.service.hrReview({
    companyId: COMPANY,
    settlementId: created.settlementId,
    checklist: { attendanceVerified: true },
    complete: false,
    actor: hrActor,
  });
  assert.equal(partial.checklist.attendanceVerified, true);
  assert.equal(partial.status, 'CALCULATED');

  const reviewed = await harness.service.hrReview({
    companyId: COMPANY,
    settlementId: created.settlementId,
    checklist: fullChecklist(),
    complete: true,
    actor: hrActor,
  });
  assert.equal(reviewed.status, 'HR_REVIEWED');
  assert.equal(reviewed.approval.hrReviewedByName, hrActor.name);
  // §22 — HR completed the settlement → Finance.
  const note = harness.state.notifications.find((entry) => entry.type === 'FNF_HR_REVIEWED');
  assert.ok(note);
  assert.equal(note.permission, 'FINAL_SETTLEMENT_APPROVE');
});

// ── §13 — Finance adds a recovery (audit pass) ─────────────────────────────

test('§13 Finance records a recovery for an unreturned asset at their own stage', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });

  // Before HR review Finance has no business touching it.
  await assert.rejects(
    () => harness.service.addRecovery({
      companyId: COMPANY,
      settlementId: created.settlementId,
      item: { type: 'ASSET', amount: 40000, reason: 'Laptop not returned' },
      actor: financeActor,
    }),
    /with Finance/i,
  );

  await harness.service.hrReview({
    companyId: COMPANY, settlementId: created.settlementId, checklist: fullChecklist(), complete: true, actor: hrActor,
  });

  const before = await harness.service.getSettlement({ companyId: COMPANY, settlementId: created.settlementId });

  // §9 — the same rules the Payroll Admin's editor obeys.
  await assert.rejects(
    () => harness.service.addRecovery({
      companyId: COMPANY, settlementId: created.settlementId,
      item: { type: 'ASSET', amount: 0, reason: 'Laptop not returned' }, actor: financeActor,
    }),
    /amount/i,
  );
  await assert.rejects(
    () => harness.service.addRecovery({
      companyId: COMPANY, settlementId: created.settlementId,
      item: { type: 'ASSET', amount: 40000, reason: '  ' }, actor: financeActor,
    }),
    /reason/i,
  );
  // §13 — Finance may add a recovery, never a payable: the type catalogue is
  // the recovery catalogue, so a bonus type cannot even be expressed here.
  await assert.rejects(
    () => harness.service.addRecovery({
      companyId: COMPANY, settlementId: created.settlementId,
      item: { type: 'PERFORMANCE_BONUS', amount: 40000, reason: 'Being generous' }, actor: financeActor,
    }),
    /type/i,
  );

  const after = await harness.service.addRecovery({
    companyId: COMPANY,
    settlementId: created.settlementId,
    item: { type: 'ASSET', amount: 40000, reason: 'Laptop not returned' },
    actor: financeActor,
  });

  // The recovery lands, and the net moves by exactly that amount.
  assert.equal(after.recoveries.items.length, 1);
  assert.equal(after.recoveries.items[0].amount, 40000);
  assert.equal(after.recoveries.items[0].approvedByName, financeActor.name);
  assert.equal(after.totals.netSettlement, money(before.totals.netSettlement - 40000));

  // §13 — the salary figures are NOT re-derived: pending salary is untouched.
  assert.equal(after.earnings.pendingSalary.amount, before.earnings.pendingSalary.amount);

  // The settlement stays where Finance left it, and the Payroll Admin is told.
  assert.equal(after.status, 'HR_REVIEWED');
  assert.ok(harness.state.notifications.some((entry) => entry.type === 'FNF_RECOVERY_ADDED'));
  assert.ok(harness.state.audits.some((entry) => entry.action === FNF_AUDIT_ACTIONS.SETTLEMENT_RECOVERY_ADDED));

  // §14 — once closed, even Finance cannot add anything.
  await harness.service.financeDecision({
    companyId: COMPANY, settlementId: created.settlementId, action: 'APPROVE', actor: financeActor,
  });
  await harness.service.markPaid({
    companyId: COMPANY, settlementId: created.settlementId, paidAt: '2026-09-01', actor: financeActor,
  });
  await harness.service.closeSettlement({ companyId: COMPANY, settlementId: created.settlementId, actor: hrActor });
  await assert.rejects(
    () => harness.service.addRecovery({
      companyId: COMPANY, settlementId: created.settlementId,
      item: { type: 'ASSET', amount: 1, reason: 'Too late' }, actor: financeActor,
    }),
    /closed/i,
  );
});

// ── §5 / §7 — attendance is frozen with the figure it produced ─────────────

test('§5 the loss-of-pay days behind the payable days are stored, not lost', async () => {
  // Two LOP days already taken in the settlement month.
  const harness = fullHarness({ results: [result(E1, { lopDays: 2 })] });
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  const settled = await harness.service.recalculate({
    companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor,
  });

  // LWD 18 Aug, 31 working days, 2 LOP → 16 payable days, not 18.
  assert.equal(settled.earnings.pendingSalary.lopDays, 2);
  assert.equal(settled.earnings.pendingSalary.payableDays, 16);
  assert.equal(settled.earnings.pendingSalary.amount, 32000);

  // The figure survives a reload: the attendance is frozen into the record,
  // so a later edit to the month cannot quietly move a settled number.
  const reloaded = await harness.service.getSettlement({ companyId: COMPANY, settlementId: created.settlementId });
  assert.equal(reloaded.earnings.pendingSalary.lopDays, 2);

  // And the PDF says so, rather than leaving HR to explain 16 out of 31.
  const text = await extractPdfText(
    await buildFnfStatementPdf({
      settlement: reloaded, employee: reloaded.employee, company: { name: 'Crewly' },
    }),
  );
  assert.match(text, /loss of pay/i);
  assert.match(text, /16 payable day/);
});

// ── §24 — the HTTP layer must actually load (audit pass) ────────────────────

test('§24 the settlement routes, controller and validators all load', async () => {
  // A validator chain only COLLECTS errors — nothing enforces them until
  // something calls validationResult. This file once shipped without that
  // half, which left every 29.11 route unvalidated and would have crashed
  // the server on import. Loading the modules proves it cannot happen again.
  const [{ default: routes }, controller, validators] = await Promise.all([
    import('../src/routes/fnfRoutes.js'),
    import('../src/controllers/fnfController.js'),
    import('../src/validators/fnfValidator.js'),
  ]);

  assert.equal(typeof routes, 'function');
  assert.equal(typeof controller.addRecovery, 'function');
  assert.ok(Array.isArray(validators.addRecoveryValidator));

  // Every exported chain ends with the middleware that reads the errors.
  Object.entries(validators).forEach(([name, chain]) => {
    assert.ok(Array.isArray(chain), `${name} should be a validator chain`);
    assert.equal(typeof chain[chain.length - 1], 'function', `${name} must end with a result handler`);
  });

  // §13 — the recovery route exists and accepts a recovery type only.
  const recoveryRoute = routes.stack.find(
    (layer) => layer.route?.path === '/:settlementId/recoveries' && layer.route?.methods?.post,
  );
  assert.ok(recoveryRoute, 'POST /:settlementId/recoveries should be registered');
});

// ── §16 — Finance ──────────────────────────────────────────────────────────

test('§16 Finance approves, and a rejection returns to HR Review with remarks', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });
  await harness.service.hrReview({
    companyId: COMPANY, settlementId: created.settlementId, checklist: fullChecklist(), complete: true, actor: hrActor,
  });

  // A rejection without remarks is refused: HR must be told what to fix.
  await assert.rejects(
    () => harness.service.financeDecision({
      companyId: COMPANY, settlementId: created.settlementId, action: 'REJECT', remarks: '', actor: financeActor,
    }),
    /remarks/i,
  );

  const rejected = await harness.service.financeDecision({
    companyId: COMPANY, settlementId: created.settlementId, action: 'REJECT', remarks: 'Asset value missing', actor: financeActor,
  });
  // §16 — the settlement returns to the HR reviewer's workbench, where the
  // items are editable again.
  assert.equal(rejected.status, 'CALCULATED');
  assert.equal(rejected.approval.financeRemarks, 'Asset value missing');
  assert.equal(rejected.editable, true);

  // HR fixes the cause and sends it back; only then can Finance approve.
  await harness.service.hrReview({
    companyId: COMPANY, settlementId: created.settlementId, checklist: fullChecklist(), complete: true, actor: hrActor,
  });
  const approved = await harness.service.financeDecision({
    companyId: COMPANY, settlementId: created.settlementId, action: 'APPROVE', actor: financeActor,
  });
  assert.equal(approved.status, 'FINANCE_APPROVED');
  assert.equal(approved.editable, false);
  assert.equal(approved.approval.financeByName, financeActor.name);

  const audit = harness.state.audits.find((entry) => /approved by Finance/i.test(entry.action));
  assert.equal(audit.previousValue.status, 'HR_REVIEWED');
  assert.equal(audit.newValue.status, 'FINANCE_APPROVED');
});

// ── §5 — payment and closure ───────────────────────────────────────────────

test('§5 payment closes the loop and tells the employee', async () => {
  const harness = fullHarness();
  const approved = await approvedSettlement(harness);

  const paid = await harness.service.markPaid({
    companyId: COMPANY, settlementId: approved.settlementId, paidAt: '2026-09-05', reference: 'NEFT-991', actor: financeActor,
  });
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.payment.paidAt, '2026-09-05');
  assert.equal(paid.payment.reference, 'NEFT-991');

  // §22 — Settlement Paid → the employee.
  const note = harness.state.notifications.find((entry) => entry.type === 'FNF_SETTLEMENT_PAID');
  assert.ok(note);
  assert.equal(String(note.userId), String(E1));
  assert.ok(harness.state.audits.some((entry) => /marked paid/i.test(entry.action)));
});

test('§14 paying a settlement that HR has not reviewed is refused', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });
  await assert.rejects(
    () => harness.service.markPaid({ companyId: COMPANY, settlementId: created.settlementId, actor: financeActor }),
    /cannot move/i,
  );
});

test('§14 a closed settlement is immutable until it is reopened with a reason', async () => {
  const harness = fullHarness();
  const approved = await approvedSettlement(harness);
  await harness.service.markPaid({ companyId: COMPANY, settlementId: approved.settlementId, paidAt: '2026-09-05', actor: financeActor });

  const closed = await harness.service.closeSettlement({ companyId: COMPANY, settlementId: approved.settlementId, actor: payrollActor });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.locked, true);

  await assert.rejects(
    () => harness.service.recalculate({ companyId: COMPANY, settlementId: approved.settlementId, actor: payrollActor }),
    /reopen/i,
  );
  await assert.rejects(
    () => harness.service.updateItems({ companyId: COMPANY, settlementId: approved.settlementId, payables: [], actor: payrollActor }),
    /closed/i,
  );

  await assert.rejects(
    () => harness.service.reopenSettlement({ companyId: COMPANY, settlementId: approved.settlementId, remarks: '', actor: payrollActor }),
    /reason/i,
  );

  const reopened = await harness.service.reopenSettlement({
    companyId: COMPANY, settlementId: approved.settlementId, remarks: 'Gratuity recalculated after audit', actor: payrollActor,
  });
  assert.equal(reopened.status, 'REOPENED');
  assert.equal(reopened.locked, false);
  // §23 — the history keeps the whole story.
  const statuses = reopened.history.map((entry) => entry.status);
  assert.ok(statuses.includes('CLOSED'));
  assert.equal(statuses.at(-1), 'REOPENED');
});

// ── §9 / §10 — manual items ────────────────────────────────────────────────

test('§9/§10 manual payables and recoveries change the net, and system items survive', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });

  const before = await harness.service.getSettlement({ companyId: COMPANY, settlementId: created.settlementId });
  const systemCount = before.earnings.additional.filter((item) => item.source === 'SYSTEM').length;
  assert.ok(systemCount >= 2, 'leave encashment and gratuity are generated, not typed');

  await assert.rejects(
    () => harness.service.updateItems({
      companyId: COMPANY,
      settlementId: created.settlementId,
      recoveries: [{ type: 'ASSET', amount: 500, reason: '' }],
      actor: payrollActor,
    }),
    /reason/i,
  );

  const updated = await harness.service.updateItems({
    companyId: COMPANY,
    settlementId: created.settlementId,
    payables: [{ type: 'PERFORMANCE_BONUS', amount: 25000, note: 'FY bonus' }],
    recoveries: [{ type: 'ASSET', amount: 12000, reason: 'Laptop not returned' }],
    actor: payrollActor,
  });

  // The computed items are still there — an edit never wipes them.
  assert.equal(updated.earnings.additional.filter((item) => item.source === 'SYSTEM').length, systemCount);
  assert.ok(updated.earnings.additional.some((item) => item.type === 'PERFORMANCE_BONUS' && item.amount === 25000));
  // §9 — the recovery keeps its reason and its approver.
  const recovery = updated.recoveries.items[0];
  assert.equal(recovery.amount, 12000);
  assert.equal(recovery.reason, 'Laptop not returned');
  assert.equal(recovery.approvedByName, payrollActor.name);
  assert.equal(updated.totals.netSettlement, before.totals.netSettlement + 25000 - 12000);
});

test('§12 the notice decision is recorded and changes the recovery', async () => {
  const harness = fullHarness();
  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), noticePeriodDays: 60, actor: payrollActor,
  });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });

  // Resigned 18 Jun, last day 18 Aug → 62 days served of a 60-day notice.
  const served = await harness.service.getSettlement({ companyId: COMPANY, settlementId: created.settlementId });
  assert.equal(served.exit.servedDays, daysBetween('2026-06-18', '2026-08-18'));
  assert.equal(served.recoveries.notice.amount, 0);

  const bought = await harness.service.setNoticeDecision({
    companyId: COMPANY, settlementId: created.settlementId, decision: 'BUYOUT', noticePeriodDays: 90, actor: payrollActor,
  });
  assert.equal(bought.exit.noticeDecision, 'BUYOUT');
  assert.equal(bought.recoveries.notice.shortfallDays, 90 - served.exit.servedDays);
  assert.equal(
    bought.recoveries.notice.amount,
    (90 - served.exit.servedDays) * EXPECTED.dailyRate,
  );

  const waived = await harness.service.setNoticeDecision({
    companyId: COMPANY, settlementId: created.settlementId, decision: 'WAIVED', noticePeriodDays: 90, actor: payrollActor,
  });
  assert.equal(waived.recoveries.notice.amount, 0);
  assert.equal(waived.recoveries.notice.waived, true);
});

// ── §18 — the employee portal ──────────────────────────────────────────────

test('§18 an employee sees their own settlement and nothing else', async () => {
  const harness = fullHarness({ employees: [employee(E1, 'CRE-001', 'Meera Iyer'), employee(E2, 'CRE-002', 'Vikram Shetty')] });
  const approved = await approvedSettlement(harness);

  const mine = await harness.service.getMySettlement({ companyId: COMPANY, employeeId: E1 });
  assert.ok(mine);
  assert.equal(mine.settlementNumber, approved.settlementNumber);
  // §18 — the employee view is a projection, not the company record.
  assert.deepEqual(Object.keys(mine).sort(), [
    '_id', 'canDownload', 'earnings', 'exit', 'month', 'monthLabel', 'payment',
    'recoveries', 'settlementNumber', 'status', 'statusLabel', 'totals',
  ]);

  // Another employee has nothing to see.
  assert.equal(await harness.service.getMySettlement({ companyId: COMPANY, employeeId: E2 }), null);

  // §18 — the statement is downloadable once paid, not before.
  await assert.rejects(
    () => harness.service.downloadMyStatement({ companyId: COMPANY, employeeId: E1, actor: { _id: E1 } }),
    /paid/i,
  );

  await harness.service.markPaid({ companyId: COMPANY, settlementId: approved.settlementId, paidAt: '2026-09-05', actor: financeActor });
  const file = await harness.service.downloadMyStatement({ companyId: COMPANY, employeeId: E1, actor: { _id: E1 } });
  assert.match(file.filename, /^FNF-202608-0001.*\.pdf$/);
  assert.ok(file.content.length > 1000, 'the F&F statement is a real PDF');
  assert.match(file.content.slice(0, 5).toString('latin1'), /%PDF/);
});

test('§24 an employee cannot download another employee statement through the portal', async () => {
  const harness = fullHarness({ employees: [employee(E1, 'CRE-001', 'Meera Iyer'), employee(E2, 'CRE-002', 'Vikram Shetty')] });
  const approved = await approvedSettlement(harness);
  await harness.service.markPaid({ companyId: COMPANY, settlementId: approved.settlementId, paidAt: '2026-09-05', actor: financeActor });

  // E2 has no settlement at all, so the self-service read finds nothing.
  await assert.rejects(
    () => harness.service.downloadMyStatement({ companyId: COMPANY, employeeId: E2, actor: { _id: E2 } }),
    /no final settlement/i,
  );
});

// ── §3 / §24 — tenant isolation ────────────────────────────────────────────

test('§3 another company cannot read or change this settlement', async () => {
  const harness = fullHarness();
  const approved = await approvedSettlement(harness);
  const count = harness.state.settlements.rows.length;

  await assert.rejects(
    () => harness.service.getSettlement({ companyId: OTHER_COMPANY, settlementId: approved.settlementId }),
    /not found/i,
  );
  await assert.rejects(
    () => harness.service.markPaid({ companyId: OTHER_COMPANY, settlementId: approved.settlementId, actor: financeActor }),
    /not found/i,
  );
  // Nothing was written for the other tenant.
  assert.equal(harness.state.settlements.rows.length, count);
  assert.ok(harness.state.settlements.rows.every((row) => String(row.companyId) === COMPANY));
});

test('§24 the payroll scope narrows the list to the employees a manager may see', async () => {
  const harness = fullHarness();
  await approvedSettlement(harness);

  const visible = await harness.service.listSettlements({ companyId: COMPANY, allowedEmployeeIds: [E1] });
  assert.equal(visible.length, 1);

  const hidden = await harness.service.listSettlements({ companyId: COMPANY, allowedEmployeeIds: [E2] });
  assert.equal(hidden.length, 0);
});

// ── §20 — cache ────────────────────────────────────────────────────────────

test('§20 the dashboard is cached, and every status change drops the cache', async () => {
  const harness = fullHarness();
  const before = harness.state.invalidations.length;

  const first = await harness.service.getDashboard({ companyId: COMPANY });
  const second = await harness.service.getDashboard({ companyId: COMPANY });
  assert.deepEqual(first.kpis, second.kpis);
  assert.ok(harness.cache.store.size > 0, 'the dashboard was cached');

  const created = await harness.service.createSettlement({
    companyId: COMPANY, employeeId: E1, resignationId: oid(80), actor: payrollActor,
  });
  assert.ok(harness.state.invalidations.length > before);

  // The employee's own cached view goes too, so the portal cannot show a
  // stale status after Finance approves.
  await harness.service.getMySettlement({ companyId: COMPANY, employeeId: E1 });
  await harness.service.recalculate({ companyId: COMPANY, settlementId: created.settlementId, actor: payrollActor });
  const last = harness.state.invalidations.at(-1);
  assert.equal(String(last.companyId), COMPANY);
});

// ── §21 — queue payloads carry references only ─────────────────────────────

test('§21 an F&F payload may carry references, never a rupee or a name', () => {
  const statement = validateFnfStatementPayload({
    companyId: COMPANY,
    settlementId: oid(1),
    actorId: oid(2),
  });
  assert.equal(statement.valid, true);

  const leaked = validateFnfStatementPayload({
    companyId: COMPANY,
    settlementId: oid(1),
    netSettlement: 125000,
  });
  assert.equal(leaked.valid, false);
  assert.ok(leaked.errors.some((message) => /netSettlement/.test(message)));

  const named = validateFnfStatementPayload({
    companyId: COMPANY,
    settlementId: oid(1),
    employeeName: 'Meera Iyer',
  });
  assert.equal(named.valid, false);

  const register = validateFnfRegisterPayload({
    companyId: COMPANY,
    fileId: oid(3),
    month: MONTH,
    format: 'xlsx',
  });
  assert.equal(register.valid, true);

  const badFormat = validateFnfRegisterPayload({
    companyId: COMPANY,
    fileId: oid(3),
    month: MONTH,
    format: 'pdf',
  });
  assert.equal(badFormat.valid, false);

  const rows = validateFnfRegisterPayload({
    companyId: COMPANY,
    fileId: oid(3),
    rows: [[1, 2, 3]],
  });
  assert.equal(rows.valid, false);
  assert.ok(rows.errors.some((message) => /rows/.test(message)));
});

// ── §21 — the statement and the register ───────────────────────────────────

test('§17 the F&F statement is a real PDF carrying the figures HR approved', async () => {
  const harness = fullHarness();
  const approved = await approvedSettlement(harness);
  await harness.service.markPaid({ companyId: COMPANY, settlementId: approved.settlementId, paidAt: '2026-09-05', reference: 'NEFT-991', actor: financeActor });

  const result = await harness.service.requestStatement({ companyId: COMPANY, settlementId: approved.settlementId, actor: payrollActor });
  assert.equal(result.status, 'READY');
  assert.match(result.filename, /^FNF-202608-0001.*\.pdf$/);

  const downloaded = await harness.service.downloadStatement({ companyId: COMPANY, settlementId: approved.settlementId, actor: payrollActor });
  const text = await extractPdfText(downloaded.content);

  assert.match(text, /Full & Final Settlement Statement/);
  assert.match(text, /FNF-202608-0001/);
  assert.match(text, /Meera Iyer/);
  assert.match(text, /CRE-001/);
  // §11 — earnings, recoveries and the net amount are all on the page.
  assert.match(text, /Pending Salary/);
  assert.match(text, /Leave Encashment/);
  assert.match(text, /Total Recoveries/);
  assert.match(text, /Net Settlement/);
  assert.match(text, /36,000/);   // pending salary, Indian grouping
  assert.match(text, /16,000/);   // leave encashment
  // §17 — the approval information, and the payment reference.
  assert.match(text, /Approval Information/);
  assert.match(text, /NEFT-991/);
  // §26 — no signature line and no legal-document claim.
  assert.doesNotMatch(text, /Signature of the employee/i);
  assert.match(text, /not a legal document/i);
});

test('§21 the settlement register exports CSV and XLSX with the same figures', async () => {
  const harness = fullHarness();
  await approvedSettlement(harness);

  const csv = await harness.service.getRegister({ companyId: COMPANY, month: MONTH });
  assert.equal(csv.filename, 'final-settlement-register-2026-08.csv');
  const text = csv.content.toString('utf8');
  assert.ok(text.includes('Meera Iyer'));
  assert.ok(text.includes('FNF-202608-0001'));
  assert.equal(text.trim().split('\n')[0].split(',').length, REGISTER_HEADERS.length);

  const xlsx = await harness.service.getRegister({ companyId: COMPANY, month: MONTH, format: 'XLSX' });
  assert.equal(xlsx.filename, 'final-settlement-register-2026-08.xlsx');
  // A real XLSX is a ZIP container.
  assert.match(xlsx.content.slice(0, 2).toString('latin1'), /PK/);

  // §3 — another tenant's register is empty, never the whole table.
  const other = await harness.service.getRegister({ companyId: OTHER_COMPANY, month: MONTH });
  assert.equal(other.rows, 0);
});

test('§21 a queued register falls back to building inline when the worker is down', async () => {
  const harness = fullHarness();
  await approvedSettlement(harness);

  const result = await harness.service.requestRegister({ companyId: COMPANY, month: MONTH, format: 'CSV', actor: payrollActor });
  assert.equal(result.queued, false);
  assert.ok(result.filename);

  const file = await harness.service.downloadFile({ companyId: COMPANY, fileId: result.fileId, actor: payrollActor });
  assert.ok(file.content.toString('utf8').includes('Meera Iyer'));
  assert.equal(harness.state.files.rows[0].status, 'READY');
});

// ── §19 — the register table shape ─────────────────────────────────────────

test('§19 the register row keeps recoveries separate from salary', () => {
  const rows = registerRows({
    rows: [
      {
        settlementNumber: 'FNF-202608-0001',
        employee: { employeeCode: 'CRE-001', name: 'Meera Iyer', departmentName: 'Engineering', designation: 'Senior Engineer' },
        month: '2026-08',
        exit: { resignationDate: '2026-06-18', lastWorkingDate: '2026-08-18', noticeDecision: 'BUYOUT' },
        earnings: { pendingSalary: { payableDays: 18, amount: 36000 }, leaveEncashment: { amount: 16000 }, gratuity: { amount: 125192.3 } },
        recoveries: { notice: { amount: 2000 } },
        totals: { totalManualAdditional: 5000, otherRecoveries: 1500, netSettlement: 180692.3 },
        status: 'PAID',
        payment: { paidAt: '2026-09-05' },
      },
    ],
  });

  assert.equal(rows[0].length, REGISTER_HEADERS.length);
  assert.equal(rows[0][0], 'FNF-202608-0001');
  assert.equal(rows[0][9], 18);          // payable days
  assert.equal(rows[0][10], 36000);      // pending salary
  assert.equal(rows[0][12], 125192.3);   // gratuity
  assert.equal(rows[0][14], 2000);       // notice recovery — on its own column
  assert.equal(rows[0][15], 1500);       // other recoveries
  assert.equal(rows[0][16], 180692.3);   // net settlement
  assert.equal(rows[0][17], 'Paid');
});

// ── §18 — the employee projection ──────────────────────────────────────────

test('§18 the employee projection hides the company record and gates the download', () => {
  const view = toEmployeeSettlementView({
    _id: oid(1),
    settlementNumber: 'FNF-202608-0001',
    status: 'HR_REVIEWED',
    month: '2026-08',
    exit: { lastWorkingDate: '2026-08-18', noticeDecision: 'WAIVED' },
    totals: { netSettlement: 52000 },
  });
  assert.equal(view.canDownload, false);
  assert.equal(view.statusLabel, 'HR Reviewed');
  assert.equal(view.exit.noticeDecisionLabel, 'Notice Waived');

  const paid = toEmployeeSettlementView({ status: 'PAID', totals: { netSettlement: 52000 } });
  assert.equal(paid.canDownload, true);
  const closed = toEmployeeSettlementView({ status: 'CLOSED', totals: { netSettlement: 52000 } });
  assert.equal(closed.canDownload, true);
});

// pdf-parse v2: `new PDFParse({ data })`, not the v1 callback signature.
const extractPdfText = async (buffer) => {
  const mod = await import('pdf-parse');
  const PDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy?.();
  return String(result?.text || '');
};
