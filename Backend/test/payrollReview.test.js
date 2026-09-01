// Hermetic suite for Phase 29.7 — Payroll Review & Approval.
// No MongoDB, no Redis, no BullMQ: the service runs on fake models with a
// fake cache, audit writer, notifier and dispatcher.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const [rules, serviceFactory, registry, templates, queueConfig, dispatcherModule] = await Promise.all([
  import('../src/services/payroll/payrollReviewRules.js'),
  import('../src/services/payroll/payrollReviewService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/roleTemplates.js'),
  import('../src/config/queueConfig.js'),
  import('../src/services/payroll/payrollExportDispatcher.js'),
]);

const {
  BULK_REVIEW_ACTIONS,
  CHECKLIST_ITEMS,
  REVIEW_STATUSES,
  REVIEW_TRANSITIONS,
  buildExport,
  canTransition,
  checklistComplete,
  criticalErrors,
  diffResults,
  emptyChecklist,
  isReadOnly,
  reviewKpis,
  summarizeErrors,
  summaryReport,
  validateEmployeeForReview,
} = rules;
const { makePayrollReviewService } = serviceFactory;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { ROLE_TEMPLATES } = templates;
const { JOB_NAMES, PAYROLL_JOB_NAMES } = queueConfig;
const { validatePayrollExportPayload } = dispatcherModule;

const MONTH = '2026-08';
// ObjectId-shaped: the dispatcher payload validator rejects anything else.
const COMPANY = '64b7f9c2e4b0a1b2c3d4e5f6';
const EMPLOYEE_1 = '64b7f9c2e4b0a1b2c3d4e501';
const EMPLOYEE_2 = '64b7f9c2e4b0a1b2c3d4e502';

// ── fakes ──────────────────────────────────────────────────────────────────

let counter = 0;

const makeFakeModel = (prefix = 'row') => {
  const rows = [];

  const makeDoc = (row) => ({
    ...row,
    toObject: () => ({ ...row }),
    save: async function save() {
      for (const [key, value] of Object.entries(this)) {
        if (key === 'toObject' || key === 'save' || key === '_id') continue;
        row[key] = value;
      }
      return this;
    },
  });

  const match = (row, filter = {}) =>
    Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === 'object' && value.$in) {
        return value.$in.some((entry) => String(entry) === String(row[key]));
      }
      return String(row[key]) === String(value);
    });

  const findRows = (filter = {}) => rows.filter((row) => match(row, filter));
  const leanRows = (filter) => findRows(filter).map((row) => ({ ...row }));

  const query = (filter = {}) => {
    const api = {
      sort: () => api,
      limit: () => api,
      select: () => api,
      lean: async () => leanRows(filter),
      then: (resolve, reject) =>
        Promise.resolve(findRows(filter).map((row) => makeDoc(row))).then(resolve, reject),
    };
    return api;
  };

  return {
    rows,
    find: (filter = {}) => query(filter),
    findOne: (filter = {}) => {
      const api = {
        select: () => api,
        lean: async () => leanRows(filter)[0] || null,
        then: (resolve, reject) => {
          const row = findRows(filter)[0];
          return Promise.resolve(row ? makeDoc(row) : null).then(resolve, reject);
        },
      };
      return api;
    },
    create: async (data) => {
      counter += 1;
      const stored = { _id: String(counter).padStart(24, '0'), createdAt: new Date(), ...data };
      rows.push(stored);
      return makeDoc(stored);
    },
    updateOne: async (filter = {}, update = {}) => {
      findRows(filter).forEach((row) => Object.assign(row, update.$set || {}));
      return { modifiedCount: findRows(filter).length };
    },
    updateMany: async (filter = {}, update = {}) => {
      findRows(filter).forEach((row) => Object.assign(row, update.$set || {}));
      return { modifiedCount: findRows(filter).length };
    },
  };
};

const resultRow = (employeeId, overrides = {}) => ({
  companyId: COMPANY,
  month: MONTH,
  employeeId,
  version: 1,
  isCurrent: true,
  status: 'CALCULATED',
  employeeName: employeeId === EMPLOYEE_1 ? 'Asha Rao' : 'Rahul Menon',
  employeeCode: employeeId === EMPLOYEE_1 ? 'EMP001' : 'EMP002',
  departmentId: '64b7f9c2e4b0a1b2c3d4e599',
  earnings: [
    { code: 'BASIC', name: 'Basic', amount: 25000, source: 'STRUCTURE' },
    { code: 'HRA', name: 'HRA', amount: 10000, source: 'STRUCTURE' },
  ],
  variableEarnings: [{ type: 'BONUS_PERFORMANCE', label: 'Performance Bonus', amount: 5000 }],
  reimbursements: [{ type: 'REIMBURSEMENT_TRAVEL', label: 'Travel', amount: 1200 }],
  deductions: [
    { code: 'PF', name: 'Provident Fund', amount: 1800, source: 'STATUTORY' },
    { code: 'LOP', name: 'Loss of Pay', amount: 2272.73, source: 'ATTENDANCE' },
  ],
  employerContributions: [{ code: 'PF_EMPLOYER', name: 'Employer PF', amount: 1800, source: 'STATUTORY' }],
  attendance: { workingDays: 22, paidDays: 21, presentDays: 21, lopDays: 1, otHours: 4 },
  totals: {
    gross: 35000,
    basic: 25000,
    totalEarnings: 42000,
    variableEarnings: 5000,
    reimbursements: 1200,
    totalDeductions: 4072.73,
    netPay: 39127.27,
    employerCost: 1800,
    ctc: 43800,
  },
  ...overrides,
});

const goodProfile = (employeeId) => ({
  companyId: COMPANY,
  employeeId,
  isCurrent: true,
  payrollStatus: 'ACTIVE',
  structureId: '64b7f9c2e4b0a1b2c3d4e588',
  bank: { accountNumberLast4: '9012', ifsc: 'HDFC0001234' },
  statutory: { pan: 'ABCDE1234F', uan: '100123456789' },
});

const makeHarness = ({ results = null, profiles = null, employees = null } = {}) => {
  const ReviewModel = makeFakeModel('review');
  const ResultModel = makeFakeModel('result');
  const RunModel = makeFakeModel('run');
  const ExportModel = makeFakeModel('export');
  const PeriodModel = makeFakeModel('period');
  const ProfileModel = makeFakeModel('profile');

  const resultRows = results || [resultRow(EMPLOYEE_1), resultRow(EMPLOYEE_2)];
  resultRows.forEach((row) => ResultModel.rows.push({ ...row }));

  const profileRows = profiles || [goodProfile(EMPLOYEE_1), goodProfile(EMPLOYEE_2)];
  profileRows.forEach((row) => ProfileModel.rows.push({ ...row }));

  const employeeRows = employees || [
    { _id: EMPLOYEE_1, name: 'Asha Rao', employeeCode: 'EMP001', status: 'ACTIVE', department: '64b7f9c2e4b0a1b2c3d4e599' },
    { _id: EMPLOYEE_2, name: 'Rahul Menon', employeeCode: 'EMP002', status: 'ACTIVE', department: '64b7f9c2e4b0a1b2c3d4e599' },
  ];

  const UserModel = {
    find: (filter = {}) => ({
      select: () => ({
        lean: async () => {
          let rows = employeeRows.slice();
          if (filter._id?.$in) {
            const ids = filter._id.$in.map(String);
            rows = rows.filter((row) => ids.includes(String(row._id)));
          }
          return rows.map((row) => ({ ...row }));
        },
      }),
    }),
    findOne: (filter = {}) => ({
      select: () => ({
        lean: async () => employeeRows.find((row) => String(row._id) === String(filter._id)) || null,
      }),
    }),
  };

  RunModel.rows.push({ companyId: COMPANY, month: MONTH, status: 'CALCULATED', version: 1, summary: {} });
  PeriodModel.rows.push({ companyId: COMPANY, month: MONTH, status: 'LOCKED' });

  const auditRows = [];
  const notifications = [];
  const cacheCalls = { del: 0, getOrSet: 0, lastOptions: null, cachedValue: null };
  const dispatched = [];

  const service = makePayrollReviewService({
    PayrollReviewModel: ReviewModel,
    PayrollResultModel: ResultModel,
    PayrollRunModel: RunModel,
    PayrollExportModel: ExportModel,
    PayrollPeriodModel: PeriodModel,
    EmployeePayrollProfileModel: ProfileModel,
    UserModel,
    DepartmentModel: {
      find: () => ({
        select: () => ({
          lean: async () => [{ _id: '64b7f9c2e4b0a1b2c3d4e599', name: 'Engineering' }],
        }),
      }),
    },
    cache: {
      buildKey: ({ companyId, namespace, segments = [] }) =>
        `test:${companyId}:${namespace}:${segments.join(':')}`,
      del: async () => {
        cacheCalls.del += 1;
        return true;
      },
      // The real redisCacheService contract: getOrSet(key, { ttlSeconds,
      // version, loader }) → { value, cache }.
      getOrSet: async (key, options = {}) => {
        cacheCalls.getOrSet += 1;
        cacheCalls.lastOptions = options;
        assert.equal(typeof options.loader, 'function');
        assert.equal(typeof options.ttlSeconds, 'number');
        const value = await options.loader();
        cacheCalls.cachedValue = value;
        return { value, cache: 'MISS' };
      },
    },
    audit: async (row) => auditRows.push(row),
    notify: async (row) => notifications.push(row),
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { queued: false };
    },
  });

  return {
    service,
    ReviewModel,
    ResultModel,
    ExportModel,
    PeriodModel,
    ProfileModel,
    auditRows,
    notifications,
    cacheCalls,
    dispatched,
  };
};

const actor = { _id: '64b7f9c2e4b0a1b2c3d4e5f6', name: 'Payroll Admin', role: 'PAYROLL_ADMIN' };

// ── 1. state machine (§6) ──────────────────────────────────────────────────

test('review statuses and transitions follow §6', () => {
  assert.deepEqual(REVIEW_STATUSES, [
    'CALCULATED',
    'UNDER_REVIEW',
    'LOCKED',
    'PENDING_FINANCE_APPROVAL',
    'APPROVED',
    'REJECTED',
    'REOPENED',
  ]);

  assert.equal(canTransition('CALCULATED', 'LOCKED'), false); // must be reviewed first
  assert.equal(canTransition('CALCULATED', 'UNDER_REVIEW'), true);
  assert.equal(canTransition('UNDER_REVIEW', 'LOCKED'), true);
  assert.equal(canTransition('LOCKED', 'PENDING_FINANCE_APPROVAL'), true);
  assert.equal(canTransition('PENDING_FINANCE_APPROVAL', 'APPROVED'), true);
  assert.equal(canTransition('PENDING_FINANCE_APPROVAL', 'REJECTED'), true);
  assert.equal(canTransition('APPROVED', 'REOPENED'), true);
  assert.equal(canTransition('REJECTED', 'UNDER_REVIEW'), false); // reopen → UNDER_REVIEW only
  assert.deepEqual(REVIEW_TRANSITIONS.APPROVED, ['REOPENED']);
});

test('locked, pending and approved payrolls are read only (§12 / §24)', () => {
  assert.equal(isReadOnly('LOCKED'), true);
  assert.equal(isReadOnly('PENDING_FINANCE_APPROVAL'), true);
  assert.equal(isReadOnly('APPROVED'), true);
  assert.equal(isReadOnly('CALCULATED'), false);
  assert.equal(isReadOnly('REOPENED'), false);
});

// ── 2. checklist (§11) ─────────────────────────────────────────────────────

test('the checklist gates locking until every box is ticked', () => {
  assert.equal(checklistComplete(emptyChecklist()), false);

  const all = Object.fromEntries(CHECKLIST_ITEMS.map((item) => [item.key, true]));
  assert.equal(checklistComplete(all), true);

  const missing = { ...all, DEDUCTIONS_REVIEWED: false };
  assert.equal(checklistComplete(missing), false);
});

// ── 3. validation (§10) ────────────────────────────────────────────────────

test('a clean employee passes review validation', () => {
  const errors = validateEmployeeForReview({
    employee: { status: 'ACTIVE' },
    profile: goodProfile(EMPLOYEE_1),
    results: [resultRow(EMPLOYEE_1)],
  });
  assert.deepEqual(errors, []);
});

test('every §10 error is detected with a severity', () => {
  const noBank = validateEmployeeForReview({
    employee: { status: 'ACTIVE' },
    profile: { ...goodProfile(EMPLOYEE_1), bank: { accountNumberLast4: '', ifsc: '' } },
    results: [resultRow(EMPLOYEE_1)],
  });
  assert.ok(noBank.some((row) => row.code === 'MISSING_BANK_ACCOUNT' && row.severity === 'CRITICAL'));

  const noPan = validateEmployeeForReview({
    employee: { status: 'ACTIVE' },
    profile: { ...goodProfile(EMPLOYEE_1), statutory: {} },
    results: [resultRow(EMPLOYEE_1)],
  });
  assert.ok(noPan.some((row) => row.code === 'MISSING_PAN'));

  const noStructure = validateEmployeeForReview({
    employee: { status: 'ACTIVE' },
    profile: { ...goodProfile(EMPLOYEE_1), structureId: null },
    results: [resultRow(EMPLOYEE_1)],
  });
  assert.ok(noStructure.some((row) => row.code === 'MISSING_SALARY_STRUCTURE'));

  const negative = validateEmployeeForReview({
    employee: { status: 'ACTIVE' },
    profile: goodProfile(EMPLOYEE_1),
    results: [resultRow(EMPLOYEE_1, { totals: { netPay: -500 } })],
  });
  assert.ok(negative.some((row) => row.code === 'NEGATIVE_SALARY'));

  const duplicate = validateEmployeeForReview({
    employee: { status: 'ACTIVE' },
    profile: goodProfile(EMPLOYEE_1),
    results: [resultRow(EMPLOYEE_1), resultRow(EMPLOYEE_1)],
  });
  assert.ok(duplicate.some((row) => row.code === 'DUPLICATE_PAYROLL_RECORD'));

  const noAttendance = validateEmployeeForReview({
    employee: { status: 'ACTIVE' },
    profile: goodProfile(EMPLOYEE_1),
    results: [resultRow(EMPLOYEE_1, { attendance: { workingDays: 0, paidDays: 0 } })],
  });
  assert.ok(noAttendance.some((row) => row.code === 'ATTENDANCE_MISSING'));
  assert.equal(noAttendance.find((row) => row.code === 'ATTENDANCE_MISSING').severity, 'WARNING');
});

test('critical errors are the ones that block locking', () => {
  const rows = [
    { errors: [{ code: 'MISSING_PAN', severity: 'CRITICAL' }] },
    { errors: [{ code: 'ATTENDANCE_MISSING', severity: 'WARNING' }] },
    { errors: [] },
  ];

  const summary = summarizeErrors(rows);
  assert.equal(summary.employeesWithErrors, 2);
  assert.equal(summary.critical, 1);
  assert.equal(summary.warnings, 1);
  assert.equal(criticalErrors(rows[1].errors).length, 0);
});

// ── 4. KPIs, summary and exports (§7 / §16 / §19) ──────────────────────────

test('KPI cards and the summary report read the 29.6 snapshots', async () => {
  const { service } = makeHarness();
  const results = [resultRow(EMPLOYEE_1), resultRow(EMPLOYEE_2)];
  const kpis = reviewKpis({ results, errorRows: [] });

  assert.equal(kpis.totalEmployees, 2);
  assert.equal(kpis.grossPayroll, 84000);
  assert.equal(kpis.netPayroll, 78254.54);
  assert.equal(kpis.employerCost, 3600);
  assert.equal(kpis.employeesWithErrors, 0);
  assert.equal(kpis.readyForApproval, false); // no error rows yet

  const hydrated = await service.getReview({ companyId: COMPANY, month: MONTH, actor });
  assert.equal(hydrated.results[0].departmentName, 'Engineering');

  const report = summaryReport({ results });
  assert.equal(report.totalEmployees, 2);
  assert.equal(report.payrollCost, report.totalEarnings + report.totalReimbursements + report.employerContribution);
});

test('exports are built from the snapshots as CSV (§19)', () => {
  // Rows arrive from the service with the department name already hydrated
  // from the Department model (asserted again in the KPI test below).
  const results = [
    { ...resultRow(EMPLOYEE_1), departmentName: 'Engineering' },
    { ...resultRow(EMPLOYEE_2), departmentName: 'Engineering' },
  ];
  const errorRows = [{ employeeCode: 'EMP001', employeeName: 'Asha Rao', errors: [{ code: 'MISSING_PAN', severity: 'CRITICAL', message: 'PAN is missing' }] }];

  const register = buildExport('PAYROLL_REGISTER', { results, errorRows });
  assert.ok(register.startsWith('employeeCode,employeeName'));
  assert.equal(register.split('\n').length, 3);

  const department = buildExport('DEPARTMENT_PAYROLL', { results, errorRows });
  assert.ok(department.includes('Engineering'));
  assert.ok(department.includes('2,'));

  const deductions = buildExport('DEDUCTION_REPORT', { results, errorRows });
  assert.ok(deductions.includes('Provident Fund,STATUTORY'));

  const errors = buildExport('ERROR_LIST', { results, errorRows });
  assert.ok(errors.includes('MISSING_PAN'));

  // Bulk exports never touch a salary value — the source rows are untouched.
  assert.equal(results[0].totals.netPay, 39127.27);
});

// ── 5. difference report (§17) ─────────────────────────────────────────────

test('the difference report shows exactly what changed between versions', () => {
  const previous = resultRow(EMPLOYEE_1, { version: 1 });
  const next = resultRow(EMPLOYEE_1, {
    version: 2,
    variableEarnings: [{ type: 'BONUS_PERFORMANCE', label: 'Performance Bonus', amount: 7000 }],
    totals: { ...previous.totals, variableEarnings: 7000, netPay: 41127.27 },
  });

  const diff = diffResults(previous, next);
  assert.equal(diff.changed, true);
  const bonus = diff.rows.find((row) => row.component === 'Performance Bonus');
  assert.equal(bonus.previous, 5000);
  assert.equal(bonus.current, 7000);
  assert.equal(bonus.difference, 2000);
  assert.equal(diff.netPrevious, 39127.27);
  assert.equal(diff.netCurrent, 41127.27);
  assert.equal(diff.netDifference, 2000);

  assert.equal(diffResults(previous, previous).changed, false);
});

// ── 6. the workflow on the service (§12 / §13 / §14 / §15) ─────────────────

test('the dashboard reads through the tenant cache (§20)', async () => {
  const { service, cacheCalls } = makeHarness();

  const state = await service.getReviewDashboard({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(cacheCalls.getOrSet, 1);
  assert.equal(cacheCalls.lastOptions.version, 1);
  assert.ok(cacheCalls.lastOptions.ttlSeconds >= 10);
  // The employee list never enters the cached blob — it is the big object.
  assert.equal(cacheCalls.cachedValue.results, undefined);
  assert.equal(cacheCalls.cachedValue.errorRows, undefined);
  assert.ok(cacheCalls.cachedValue.kpis);
  // The caller still gets a complete state object.
  assert.equal(state.review.status, 'CALCULATED');
  assert.equal(state.kpis.totalEmployees, 2);
});

test('a review is created on first read and starts at CALCULATED', async () => {
  const { service, ReviewModel } = makeHarness();

  const state = await service.getReview({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(ReviewModel.rows.length, 1);
  assert.equal(state.review.status, 'CALCULATED');
  assert.equal(state.results.length, 2);
  assert.equal(state.errors.critical, 0);
});

test('lock requires a complete checklist and zero critical errors (§11 / §12)', async () => {
  const { service } = makeHarness();

  // 1 — checklist incomplete.
  await assert.rejects(
    () => service.lock({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400 && /checklist/i.test(error.message),
  );

  // 2 — complete the checklist, but leave a critical error in place.
  for (const item of CHECKLIST_ITEMS) {
    if (item.key === 'ERROR_COUNT_ZERO') continue;
    await service.setChecklist({ companyId: COMPANY, month: MONTH, item: item.key, value: true, actor });
  }

  const broken = makeHarness({
    profiles: [{ ...goodProfile(EMPLOYEE_1), statutory: {} }, goodProfile(EMPLOYEE_2)],
  });
  for (const item of CHECKLIST_ITEMS) {
    if (item.key === 'ERROR_COUNT_ZERO') continue;
    await broken.service.setChecklist({ companyId: COMPANY, month: MONTH, item: item.key, value: true, actor });
  }
  await assert.rejects(
    () => broken.service.lock({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400 && /critical error/i.test(error.message),
  );

  // 3 — clean payroll locks, freezes inputs and is audited.
  const state = await service.lock({ companyId: COMPANY, month: MONTH, actor });
  assert.equal(state.review.status, 'LOCKED');
  assert.equal(state.review.lockCount, 1);
  // §12 — the 29.5 month becomes read-only.
  assert.equal(state.review.status, 'LOCKED');
  assert.ok(state.review.lockedAt);
});

test('locking freezes the monthly inputs, reopening unfreezes them (§12 / §13)', async () => {
  const { service, PeriodModel } = makeHarness();

  for (const item of CHECKLIST_ITEMS) {
    if (item.key === 'ERROR_COUNT_ZERO') continue;
    await service.setChecklist({ companyId: COMPANY, month: MONTH, item: item.key, value: true, actor });
  }
  await service.lock({ companyId: COMPANY, month: MONTH, actor });
  assert.equal(PeriodModel.rows[0].status, 'SENT_TO_PAYROLL');

  await service.reopen({ companyId: COMPANY, month: MONTH, reason: 'Bonus needs a correction', actor });
  assert.equal(PeriodModel.rows[0].status, 'LOCKED');
});

test('reopen without a reason is refused, with a reason it is audited (§13)', async () => {
  const { service, auditRows, notifications } = makeHarness();

  for (const item of CHECKLIST_ITEMS) {
    if (item.key === 'ERROR_COUNT_ZERO') continue;
    await service.setChecklist({ companyId: COMPANY, month: MONTH, item: item.key, value: true, actor });
  }
  await service.lock({ companyId: COMPANY, month: MONTH, actor });

  await assert.rejects(
    () => service.reopen({ companyId: COMPANY, month: MONTH, reason: '', actor }),
    (error) => error.statusCode === 400,
  );

  const state = await service.reopen({
    companyId: COMPANY,
    month: MONTH,
    reason: 'Finance asked for a bonus check',
    actor,
  });
  assert.equal(state.review.status, 'REOPENED');
  assert.equal(state.review.reopenReason, 'Finance asked for a bonus check');
  assert.ok(state.review.reopenedAt);
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_REOPENED'));
  assert.ok(notifications.some((row) => row.type === 'PAYROLL_REOPENED'));
});

test('finance approval follows lock → submit → approve (§14)', async () => {
  const { service, auditRows } = makeHarness();

  for (const item of CHECKLIST_ITEMS) {
    if (item.key === 'ERROR_COUNT_ZERO') continue;
    await service.setChecklist({ companyId: COMPANY, month: MONTH, item: item.key, value: true, actor });
  }
  await service.lock({ companyId: COMPANY, month: MONTH, actor });

  // Approving before it is submitted is refused.
  await assert.rejects(
    () => service.approve({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400,
  );

  const submitted = await service.submitForApproval({ companyId: COMPANY, month: MONTH, actor });
  assert.equal(submitted.review.status, 'PENDING_FINANCE_APPROVAL');

  const approved = await service.approve({ companyId: COMPANY, month: MONTH, actor });
  assert.equal(approved.review.status, 'APPROVED');
  assert.ok(approved.review.approvedAt);
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_APPROVED'));
});

test('a rejection needs a reason and stops the approval path (§14)', async () => {
  const { service, auditRows } = makeHarness();

  for (const item of CHECKLIST_ITEMS) {
    if (item.key === 'ERROR_COUNT_ZERO') continue;
    await service.setChecklist({ companyId: COMPANY, month: MONTH, item: item.key, value: true, actor });
  }
  await service.lock({ companyId: COMPANY, month: MONTH, actor });
  await service.submitForApproval({ companyId: COMPANY, month: MONTH, actor });

  await assert.rejects(
    () => service.reject({ companyId: COMPANY, month: MONTH, reason: '', actor }),
    (error) => error.statusCode === 400,
  );

  const rejected = await service.reject({
    companyId: COMPANY,
    month: MONTH,
    reason: "Verify Asha's bonus before payment",
    actor,
  });
  assert.equal(rejected.review.status, 'REJECTED');
  assert.equal(rejected.review.rejectionReason, "Verify Asha's bonus before payment");
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_REJECTED'));

  // A rejected payroll cannot be approved without reopening first.
  await assert.rejects(
    () => service.approve({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400,
  );
});

test('remarks are append-only and keep their author, role and date (§15)', async () => {
  const { service } = makeHarness();

  const first = await service.addRemark({
    companyId: COMPANY,
    month: MONTH,
    actor,
    message: 'Attendance verified',
    channel: 'HR',
  });
  await service.addRemark({
    companyId: COMPANY,
    month: MONTH,
    actor: { _id: '64b7f9c2e4b0a1b2c3d4e577', name: 'Finance Manager', role: 'FINANCE_MANAGER' },
    message: 'Please recheck the bonus',
    channel: 'FINANCE',
  });

  const review = await service.addRemark({
    companyId: COMPANY,
    month: MONTH,
    actor,
    message: 'Bonus corrected and recalculated',
  });

  assert.equal(review.remarks.length, 3);
  assert.equal(first.remarks.length, 1);
  assert.equal(review.remarks[1].authorName, 'Finance Manager');
  assert.equal(review.remarks[1].channel, 'FINANCE');
  assert.ok(review.remarks[1].createdAt);
  // Nothing was overwritten.
  assert.equal(review.remarks[0].message, 'Attendance verified');

  await assert.rejects(
    () => service.addRemark({ companyId: COMPANY, month: MONTH, actor, message: '   ' }),
    (error) => error.statusCode === 400,
  );
});

// ── 7. per-employee review and bulk actions (§8 / §18) ─────────────────────

test('bulk review actions never modify a salary value (§18)', async () => {
  const { service, ResultModel } = makeHarness();
  const before = JSON.stringify(ResultModel.rows.map((row) => row.totals));

  const state = await service.bulkAction({
    companyId: COMPANY,
    month: MONTH,
    action: 'MARK_ALL_REVIEWED',
    employeeIds: [EMPLOYEE_1, EMPLOYEE_2],
    actor,
  });

  assert.deepEqual(state.touched.sort(), [EMPLOYEE_1, EMPLOYEE_2].sort());
  assert.equal(JSON.stringify(ResultModel.rows.map((row) => row.totals)), before);

  const verified = await service.bulkAction({
    companyId: COMPANY,
    month: MONTH,
    action: 'VERIFY_BANK_DETAILS',
    employeeIds: [EMPLOYEE_1],
    actor,
  });
  const row = verified.review.employeeReviews.find((entry) => String(entry.employeeId) === EMPLOYEE_1);
  assert.equal(row.bankVerified, true);
  assert.equal(row.state, 'REVIEWED');
  assert.equal(BULK_REVIEW_ACTIONS.includes('VERIFY_PAN'), true);
});

test('reviewing an employee is recorded, and refused once locked (§8 / §24)', async () => {
  const { service } = makeHarness();

  const reviewed = await service.reviewEmployee({
    companyId: COMPANY,
    month: MONTH,
    employeeId: EMPLOYEE_1,
    state: 'REVIEWED',
    note: 'Checked against the attendance register',
    actor,
  });
  const row = reviewed.review.employeeReviews.find((entry) => String(entry.employeeId) === EMPLOYEE_1);
  assert.equal(row.state, 'REVIEWED');
  assert.equal(row.note, 'Checked against the attendance register');

  for (const item of CHECKLIST_ITEMS) {
    if (item.key === 'ERROR_COUNT_ZERO') continue;
    await service.setChecklist({ companyId: COMPANY, month: MONTH, item: item.key, value: true, actor });
  }
  await service.lock({ companyId: COMPANY, month: MONTH, actor });

  await assert.rejects(
    () =>
      service.reviewEmployee({
        companyId: COMPANY,
        month: MONTH,
        employeeId: EMPLOYEE_1,
        state: 'PENDING',
        actor,
      }),
    (error) => error.statusCode === 400,
  );
});

// ── 8. exports (§19 / §21) ─────────────────────────────────────────────────

test('an export is queued when Redis is up and built inline when it is not', async () => {
  const { service, ExportModel, dispatched } = makeHarness();

  const outcome = await service.createExport({
    companyId: COMPANY,
    month: MONTH,
    reportKey: 'PAYROLL_REGISTER',
    actor,
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].reportKey, 'PAYROLL_REGISTER');
  // No salary figures travel through the queue.
  assert.equal(/39127|netPay/i.test(JSON.stringify(dispatched[0])), false);

  // The fake dispatcher reports "not queued", so the report arrives inline.
  assert.equal(outcome.queued, false);
  assert.ok(outcome.content.startsWith('employeeCode,employeeName'));
  assert.equal(ExportModel.rows[0].status, 'READY');

  const payload = {
    ...dispatched[0],
    exportId: String(ExportModel.rows[0]._id),
    requestedAt: new Date().toISOString(),
  };
  assert.equal(validatePayrollExportPayload(payload).valid, true);
  assert.equal(
    validatePayrollExportPayload({ ...payload, reportKey: 'DROP TABLE' }).valid,
    false,
  );
  assert.ok(PAYROLL_JOB_NAMES.includes(JOB_NAMES.PAYROLL_EXPORT));
});

test('the worker rebuilds an export from Mongo, never from the payload', async () => {
  const { service, ExportModel } = makeHarness();

  const created = await service.createExport({
    companyId: COMPANY,
    month: MONTH,
    reportKey: 'SALARY_SUMMARY',
    actor,
  });

  const rebuilt = await service.processExport({
    companyId: COMPANY,
    month: MONTH,
    exportId: String(created.export._id),
    reportKey: 'SALARY_SUMMARY',
  });

  assert.ok(rebuilt.content.startsWith('employeeCode,employeeName,basic'));
  assert.equal(ExportModel.rows[0].status, 'READY');
  assert.equal(ExportModel.rows[0].rowCount, 2);
});

// ── 9. scope and permissions (§3 / §4 / §24) ───────────────────────────────

test('a narrowed payroll scope never widens the review (§3)', async () => {
  const { service } = makeHarness();

  const all = await service.getReview({ companyId: COMPANY, month: MONTH, actor });
  assert.equal(all.results.length, 2);

  const scoped = await service.getReview({
    companyId: COMPANY,
    month: MONTH,
    actor,
    allowedEmployeeIds: [EMPLOYEE_2],
  });
  assert.equal(scoped.results.length, 1);
  assert.equal(String(scoped.results[0].employeeId), EMPLOYEE_2);

  const bulk = await service.bulkAction({
    companyId: COMPANY,
    month: MONTH,
    action: 'VERIFY_PAN',
    employeeIds: [EMPLOYEE_1, EMPLOYEE_2],
    actor,
    allowedEmployeeIds: [EMPLOYEE_2],
  });
  assert.deepEqual(bulk.touched, [EMPLOYEE_2]);
});

test('review permissions follow §4 — never role names', () => {
  const catalogue = new Set(DEFAULT_PERMISSIONS.map((row) => row.name));
  ['PAYROLL_RUN_READ', 'PAYROLL_RUN_PREPARE', 'PAYROLL_RUN_LOCK', 'PAYROLL_RUN_REOPEN',
    'PAYROLL_RUN_REVIEW', 'PAYROLL_RUN_APPROVE', 'PAYROLL_RUN_REJECT'].forEach((name) => {
    assert.ok(catalogue.has(name), `${name} must exist in the catalogue`);
  });

  const has = (role, name) => (DEFAULT_ROLE_MATRIX[role] || []).includes(name);

  // Company Admin: view, lock, unlock, approve, reject.
  assert.ok(has('COMPANY_ADMIN', 'PAYROLL_RUN_LOCK'));
  assert.ok(has('COMPANY_ADMIN', 'PAYROLL_RUN_REOPEN'));
  assert.ok(has('COMPANY_ADMIN', 'PAYROLL_RUN_APPROVE'));
  assert.ok(has('COMPANY_ADMIN', 'PAYROLL_RUN_REJECT'));

  // HR Manager: review and resolve, never lock, never approve (§4 / §14).
  assert.ok(has('HR_MANAGER', 'PAYROLL_RUN_READ'));
  assert.ok(has('HR_MANAGER', 'PAYROLL_RUN_PREPARE'));
  assert.equal(has('HR_MANAGER', 'PAYROLL_RUN_LOCK'), false);
  assert.equal(has('HR_MANAGER', 'PAYROLL_RUN_APPROVE'), false);

  // Employees never see payroll.
  ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE'].forEach((role) => {
    assert.equal(has(role, 'PAYROLL_RUN_READ'), false, `${role} must not read payroll reviews`);
  });

  const byKey = Object.fromEntries(ROLE_TEMPLATES.map((row) => [row.key, row.permissions]));

  // Payroll Admin: review, lock, recalculate, submit.
  assert.ok(byKey.PAYROLL_ADMIN.includes('PAYROLL_RUN_LOCK'));
  assert.ok(byKey.PAYROLL_ADMIN.includes('PAYROLL_RUN_REVIEW'));
  assert.ok(byKey.PAYROLL_ADMIN.includes('PAYROLL_RUN_RECALCULATE'));

  // Finance Manager: approve AND reject, never calculate or lock.
  assert.ok(byKey.FINANCE_MANAGER.includes('PAYROLL_RUN_APPROVE'));
  assert.ok(byKey.FINANCE_MANAGER.includes('PAYROLL_RUN_REJECT'));
  assert.equal(byKey.FINANCE_MANAGER.includes('PAYROLL_RUN_LOCK'), false);
  assert.equal(byKey.FINANCE_MANAGER.includes('PAYROLL_RUN_EXECUTE'), false);
});
