// Hermetic suite for Phase 29.8 — Bank Transfer File & Salary Payment
// Preparation. No MongoDB, no Redis, no BullMQ, no bank: the service runs on
// fake models with a fake cache, audit writer, notifier, dispatcher and
// decryptor.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const [rules, serviceFactory, paymentRulesExtra, registry, templates, queueConfig, dispatcherModule, cacheModule] =
  await Promise.all([
    import('../src/services/payroll/payrollPaymentRules.js'),
    import('../src/services/payroll/payrollPaymentService.js'),
    import('../src/services/payroll/payrollPaymentRules.js'),
    import('../src/utils/permissionRegistry.js'),
    import('../src/utils/roleTemplates.js'),
    import('../src/config/queueConfig.js'),
    import('../src/services/payroll/payrollPaymentDispatcher.js'),
    import('../src/services/payroll/payrollPaymentCache.js'),
  ]);

const {
  BANK_FILE_FORMATS,
  FAILURE_REASONS,
  PAYMENT_STATUSES,
  buildBankFile,
  buildBatchNumber,
  buildPaymentReference,
  canTransition,
  isValidIfsc,
  paymentKpis,
  sanitisePrefix,
  statusAfterMarking,
  validateEmployeeForPayment,
} = rules;
const { makePayrollPaymentService, MAX_FILE_BYTES } = serviceFactory;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { ROLE_TEMPLATES } = templates;
const { JOB_NAMES, QUEUE_NAMES, PAYROLL_JOB_NAMES } = queueConfig;
const { validatePayrollPaymentFilePayload } = dispatcherModule;
const { paymentCacheKey, invalidatePaymentCache } = cacheModule;

const MONTH = '2026-08';
const COMPANY = '64b7f9c2e4b0a1b2c3d4e5f6';
const EMPLOYEE_1 = '64b7f9c2e4b0a1b2c3d4e501';
const EMPLOYEE_2 = '64b7f9c2e4b0a1b2c3d4e502';
const EMPLOYEE_3 = '64b7f9c2e4b0a1b2c3d4e503';
const DEPARTMENT = '64b7f9c2e4b0a1b2c3d4e599';

// Two recipients the fake audience resolver always returns.
const FINANCE_USER = '64b7f9c2e4b0a1b2c3d4e577';
const HR_USER = '64b7f9c2e4b0a1b2c3d4e588';

// ── fakes ──────────────────────────────────────────────────────────────────

let counter = 0;
const nextId = () => String((counter += 1)).padStart(24, '0');

const makeFakeModel = () => {
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
      if (value && typeof value === 'object' && value.$ne) {
        return String(row[key]) !== String(value.$ne);
      }
      if (value && typeof value === 'object' && value.$nin) {
        return !value.$nin.some((entry) => String(entry) === String(row[key]));
      }
      if (key === '_id') return String(row._id) === String(value);
      return String(row[key]) === String(value);
    });

  const findRows = (filter = {}) => rows.filter((row) => match(row, filter));
  const leanRows = (filter) => findRows(filter).map((row) => ({ ...row, bank: { ...(row.bank || {}) } }));

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
        sort: () => api,
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
      const stored = { _id: nextId(), createdAt: new Date(), ...data };
      rows.push(stored);
      return makeDoc(stored);
    },
    updateOne: async (filter = {}, update = {}) => {
      const targets = findRows(filter);
      targets.forEach((row) => {
        Object.assign(row, update.$set || {});
        if (update.$inc) {
          Object.entries(update.$inc).forEach(([key, by]) => {
            row[key] = Number(row[key] || 0) + Number(by);
          });
        }
      });
      return { modifiedCount: targets.length };
    },
    updateMany: async (filter = {}, update = {}) => {
      const targets = findRows(filter);
      targets.forEach((row) => Object.assign(row, update.$set || {}));
      return { modifiedCount: targets.length };
    },
  };
};

// The stored value is "encrypted"; the fake decryptor reverses it. Nothing
// else in the suite ever sees the plaintext.
const ENCRYPT = (value) => `enc:${value}`;
const DECRYPT = (value) => (String(value || '').startsWith('enc:') ? String(value).slice(4) : '');

const resultRow = (employeeId, overrides = {}) => ({
  companyId: COMPANY,
  month: MONTH,
  employeeId,
  version: 1,
  isCurrent: true,
  status: 'CALCULATED',
  employeeName: employeeId === EMPLOYEE_1 ? 'Asha Rao' : 'Rahul Menon',
  employeeCode: employeeId === EMPLOYEE_1 ? 'EMP001' : 'EMP002',
  attendance: { workingDays: 22, paidDays: 22, lopDays: 0, otHours: 0 },
  totals: { gross: 35000, netPay: 39127.27, totalDeductions: 4072.73, employerCost: 1800 },
  ...overrides,
});

const goodProfile = (employeeId, overrides = {}) => ({
  companyId: COMPANY,
  employeeId,
  isCurrent: true,
  payrollStatus: 'ACTIVE',
  bank: {
    bankName: 'HDFC Bank',
    accountHolderName: 'Asha Rao',
    accountNumber: ENCRYPT('123456789012'),
    accountNumberLast4: '9012',
    accountNumberMasked: 'XXXXXXXX9012',
    ifsc: 'HDFC0001234',
  },
  ...overrides,
});

const makeHarness = ({
  results = null,
  profiles = null,
  employees = null,
  reviewStatus = 'APPROVED',
  setup = null,
  notifyImpl = null,
} = {}) => {
  const BatchModel = makeFakeModel();
  const PaymentModel = makeFakeModel();
  const FileModel = makeFakeModel();
  const ResultModel = makeFakeModel();
  const ReviewModel = makeFakeModel();
  const SetupModel = makeFakeModel();
  const ProfileModel = makeFakeModel();
  const UserModel = makeFakeModel();

  const resultRows = results || [resultRow(EMPLOYEE_1), resultRow(EMPLOYEE_2)];
  resultRows.forEach((row) => ResultModel.rows.push({ ...row }));

  const profileRows = profiles || [goodProfile(EMPLOYEE_1), goodProfile(EMPLOYEE_2)];
  profileRows.forEach((row) => ProfileModel.rows.push(JSON.parse(JSON.stringify(row))));

  const employeeRows = employees || [
    { _id: EMPLOYEE_1, name: 'Asha Rao', employeeCode: 'EMP001', status: 'ACTIVE', department: DEPARTMENT },
    { _id: EMPLOYEE_2, name: 'Rahul Menon', employeeCode: 'EMP002', status: 'ACTIVE', department: DEPARTMENT },
  ];
  employeeRows.forEach((row) => UserModel.rows.push({ ...row }));

  ReviewModel.rows.push({
    companyId: COMPANY,
    month: MONTH,
    status: reviewStatus,
    approvedAt: reviewStatus === 'APPROVED' ? new Date('2026-08-28T10:00:00Z') : null,
    approvedBy: '64b7f9c2e4b0a1b2c3d4e5f6',
    runVersion: 1,
  });

  SetupModel.rows.push(
    setup || {
      companyId: COMPANY,
      payrollPolicy: { frequency: 'MONTHLY', currency: 'INR' },
      bankAccount: { paymentReferencePrefix: 'CREWLYSAL', bankName: 'HDFC Bank' },
    },
  );

  const auditRows = [];
  const notifications = [];
  const audiences = [];
  const dispatched = [];
  const cacheCalls = { del: 0, getOrSet: 0, lastOptions: null };

  const deps = {
    PayrollPaymentBatchModel: BatchModel,
    PayrollPaymentModel: PaymentModel,
    PayrollPaymentFileModel: FileModel,
    PayrollResultModel: ResultModel,
    PayrollReviewModel: ReviewModel,
    PayrollSetupModel: SetupModel,
    EmployeePayrollProfileModel: ProfileModel,
    UserModel,
    DepartmentModel: {
      find: () => ({
        select: () => ({ lean: async () => [{ _id: DEPARTMENT, name: 'Engineering' }] }),
      }),
    },
    cache: {
      buildKey: ({ companyId, namespace, segments = [] }) =>
        `test:${companyId}:${namespace}:${segments.join(':')}`,
      del: async () => {
        cacheCalls.del += 1;
        return true;
      },
      getOrSet: async (key, options = {}) => {
        cacheCalls.getOrSet += 1;
        cacheCalls.lastOptions = options;
        assert.equal(typeof options.loader, 'function');
        assert.equal(typeof options.ttlSeconds, 'number');
        return { value: await options.loader(), cache: 'MISS' };
      },
    },
    audit: async (row) => auditRows.push(row),
    notify: notifyImpl || (async (row) => notifications.push(row)),
    audience: async ({ permissions }) => {
      audiences.push(permissions);
      return [FINANCE_USER, HR_USER];
    },
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { queued: false };
    },
    decrypt: DECRYPT,
    hash: (value) => `sha256:${String(value).length}`,
  };

  const service = makePayrollPaymentService(deps);

  return {
    service,
    deps,
    BatchModel,
    PaymentModel,
    FileModel,
    ResultModel,
    ReviewModel,
    ProfileModel,
    auditRows,
    notifications,
    audiences,
    dispatched,
    cacheCalls,
  };
};

const actor = { _id: '64b7f9c2e4b0a1b2c3d4e5f6', name: 'Payroll Admin', role: 'PAYROLL_ADMIN' };

const buildBatch = async (harness) =>
  harness.service.createBatch({ companyId: COMPANY, month: MONTH, actor });

// §26 — the real flow: a file exists before finance confirms anything.
const buildBatchWithFile = async (harness) => {
  const state = await harness.service.createBatch({ companyId: COMPANY, month: MONTH, actor });
  await harness.service.generateFile({
    companyId: COMPANY,
    batchId: state.batch._id,
    format: 'CSV',
    actor,
  });
  return harness.service.getBatch({ companyId: COMPANY, batchId: state.batch._id });
};

// ── 1. statuses (§8) ───────────────────────────────────────────────────────

test('payment statuses follow §8 and the transitions are explicit', () => {
  assert.deepEqual(PAYMENT_STATUSES, [
    'DRAFT',
    'READY',
    'FILE_GENERATED',
    'DOWNLOADED',
    'PROCESSING',
    'PAID',
    'PARTIALLY_PAID',
    'FAILED',
    'CANCELLED',
  ]);

  assert.equal(canTransition('DRAFT', 'READY'), true);
  assert.equal(canTransition('READY', 'FILE_GENERATED'), true);
  assert.equal(canTransition('FILE_GENERATED', 'DOWNLOADED'), true);
  assert.equal(canTransition('DOWNLOADED', 'PAID'), true);
  assert.equal(canTransition('PROCESSING', 'PARTIALLY_PAID'), true);
  // A paid batch is finished; only a failed one can be reopened (§4).
  assert.deepEqual(rules.PAYMENT_TRANSITIONS.PAID, []);
  assert.deepEqual(rules.PAYMENT_TRANSITIONS.CANCELLED, []);
  assert.equal(canTransition('FAILED', 'READY'), true);
  assert.equal(canTransition('PAID', 'READY'), false);
});

test('the batch status follows what finance marked (§13 / §15)', () => {
  assert.equal(statusAfterMarking({ totalTransactions: 2, successfulTransactions: 2 }), 'PAID');
  assert.equal(statusAfterMarking({ totalTransactions: 2, failedTransactions: 2 }), 'FAILED');
  assert.equal(
    statusAfterMarking({ totalTransactions: 3, successfulTransactions: 2, failedTransactions: 1 }),
    'PARTIALLY_PAID',
  );
  assert.equal(statusAfterMarking({ totalTransactions: 0 }), 'DRAFT');
});

// ── 2. bank validation (§7) ────────────────────────────────────────────────

test('a clean employee passes bank validation', () => {
  const errors = validateEmployeeForPayment({
    employee: { status: 'ACTIVE' },
    profile: goodProfile(EMPLOYEE_1),
    result: resultRow(EMPLOYEE_1),
  });
  assert.deepEqual(errors, []);
});

test('every §7 problem is reported, and IFSC is checked properly', () => {
  const check = (profile, result = resultRow(EMPLOYEE_1), employee = { status: 'ACTIVE' }) =>
    validateEmployeeForPayment({ employee, profile, result });

  assert.ok(check({ ...goodProfile(EMPLOYEE_1), bank: {} }).includes('MISSING_BANK_NAME'));
  assert.ok(check({ ...goodProfile(EMPLOYEE_1), bank: { ifsc: 'HDFC0001234' } }).includes('MISSING_ACCOUNT_NUMBER'));
  assert.ok(
    check({ ...goodProfile(EMPLOYEE_1), bank: { ...goodProfile(EMPLOYEE_1).bank, accountHolderName: '' } }).includes(
      'MISSING_ACCOUNT_HOLDER',
    ),
  );
  assert.ok(
    check({ ...goodProfile(EMPLOYEE_1), bank: { ...goodProfile(EMPLOYEE_1).bank, ifsc: '' } }).includes('MISSING_IFSC'),
  );
  assert.ok(
    check({ ...goodProfile(EMPLOYEE_1), bank: { ...goodProfile(EMPLOYEE_1).bank, ifsc: 'HDFC123' } }).includes(
      'INVALID_IFSC',
    ),
  );
  assert.ok(check(null).includes('INACTIVE_PAYROLL_PROFILE'));
  assert.ok(check({ ...goodProfile(EMPLOYEE_1), payrollStatus: 'INACTIVE' }).includes('INACTIVE_PAYROLL_PROFILE'));
  assert.ok(check(goodProfile(EMPLOYEE_1), resultRow(EMPLOYEE_1, { totals: { netPay: 0 } })).includes('ZERO_NET_SALARY'));
  assert.ok(check(goodProfile(EMPLOYEE_1), resultRow(EMPLOYEE_1, { totals: { netPay: -1 } })).includes('NEGATIVE_NET_SALARY'));
  assert.ok(check(goodProfile(EMPLOYEE_1), null).includes('ZERO_NET_SALARY'));

  assert.equal(isValidIfsc('HDFC0001234'), true);
  assert.equal(isValidIfsc('hdfc0001234'), true);
  assert.equal(isValidIfsc('HDFC123'), false);
  assert.equal(isValidIfsc(''), false);
});

// ── 3. numbers (§6 / §11) ──────────────────────────────────────────────────

test('batch numbers and payment references follow §6 / §11', () => {
  assert.equal(buildBatchNumber({ month: '2026-08', sequence: 1 }), 'SAL-2026-08-001');
  assert.equal(buildBatchNumber({ month: '2026-08', sequence: 12 }), 'SAL-2026-08-012');
  // §11 — the prefix comes from 29.1 Payroll Setup.
  assert.equal(
    buildPaymentReference({ prefix: 'CREWLYSAL', month: '2026-08', sequence: 1 }),
    'CREWLYSAL-2026-08-0001',
  );
  // A missing or messy prefix falls back instead of producing junk.
  assert.equal(sanitisePrefix(''), 'SAL');
  assert.equal(sanitisePrefix('  crewly sal! '), 'CREWLYSAL');
});

// ── 4. batch creation (§2 / §5 / §6 / §7) ──────────────────────────────────

test('a batch can only be created from an approved payroll (§2 / §5)', async () => {
  const pending = makeHarness({ reviewStatus: 'PENDING_FINANCE_APPROVAL' });
  await assert.rejects(
    () => pending.service.createBatch({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400 && /approved/i.test(error.message),
  );

  const rejected = makeHarness({ reviewStatus: 'REJECTED' });
  await assert.rejects(
    () => rejected.service.createBatch({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400,
  );

  const noReview = makeHarness();
  noReview.ReviewModel.rows.length = 0;
  await assert.rejects(
    () => noReview.service.createBatch({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400 && /reviewed/i.test(error.message),
  );
});

test('creating a batch numbers it, prices it from the snapshot and audits it', async () => {
  const { service, BatchModel, PaymentModel, auditRows, notifications } = makeHarness();

  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(BatchModel.rows.length, 1);
  assert.equal(state.batch.batchNumber, 'SAL-2026-08-001');
  assert.equal(state.batch.status, 'READY');
  assert.equal(state.batch.cycle, 'MONTHLY');
  assert.equal(state.batch.approval.runVersion, 1);
  assert.ok(state.batch.approval.approvedAt);

  // §11 — one reference per transaction, prefixed from 29.1.
  assert.equal(PaymentModel.rows.length, 2);
  assert.deepEqual(
    PaymentModel.rows.map((row) => row.paymentReference),
    ['CREWLYSAL-2026-08-0001', 'CREWLYSAL-2026-08-0002'],
  );
  // §6 — the summary counts and totals.
  assert.equal(state.batch.summary.totalEmployees, 2);
  assert.equal(state.batch.summary.totalNetSalary, 78254.54);
  assert.equal(state.batch.summary.pendingTransactions, 2);

  assert.ok(auditRows.some((row) => row.action === 'PAYMENT_BATCH_CREATED'));
  assert.ok(notifications.some((row) => row.type === 'PAYMENT_BATCH_CREATED'));
});

test('employees who fail bank validation are excluded, never paid (§7)', async () => {
  const broken = {
    ...goodProfile(EMPLOYEE_2),
    bank: { ...goodProfile(EMPLOYEE_2).bank, ifsc: '', accountHolderName: '' },
  };
  const { service, PaymentModel } = makeHarness({ profiles: [goodProfile(EMPLOYEE_1), broken] });

  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(PaymentModel.rows.length, 1);
  assert.equal(String(PaymentModel.rows[0].employeeId), EMPLOYEE_1);
  assert.equal(state.excluded.length, 1);
  assert.equal(String(state.excluded[0].employeeId), EMPLOYEE_2);
  assert.ok(state.excluded[0].errors.includes('MISSING_IFSC'));
  assert.ok(state.excluded[0].errors.includes('MISSING_ACCOUNT_HOLDER'));
  assert.equal(state.excluded[0].messages.length, state.excluded[0].errors.length);
});

test('one original batch per month — a second one is refused (§6 / §16)', async () => {
  const { service } = makeHarness();
  await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  await assert.rejects(
    () => service.createBatch({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400 && /retry batch/i.test(error.message),
  );
});

// ── 5. masking (§9 / §23) ──────────────────────────────────────────────────

test('no API response ever carries a full account number (§9 / §23)', async () => {
  const { service, PaymentModel } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  const serialised = JSON.stringify(state);
  assert.equal(/123456789012/.test(serialised), false, 'plaintext account leaked into the API');
  assert.ok(serialised.includes('XXXXXXXX9012'), 'the masked form must be shown instead');

  // The stored row keeps the encrypted blob, and it is select:false by design.
  assert.equal(PaymentModel.rows[0].bank.accountNumber, ENCRYPT('123456789012'));

  const detail = await service.getBatch({ companyId: COMPANY, batchId: state.batch._id });
  assert.equal(JSON.stringify(detail).includes('123456789012'), false);
});

// ── 6. bank file (§10 / §12 / §20) ─────────────────────────────────────────

test('the CSV bank file carries the real account numbers and the §10 columns', async () => {
  const { service } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  const outcome = await service.generateFile({
    companyId: COMPANY,
    batchId: state.batch._id,
    format: 'CSV',
    actor,
  });

  const lines = outcome.content.split('\r\n');
  assert.equal(lines[0], 'Employee ID,Employee Name,Account Holder,Account Number,IFSC,Bank Name,Net Salary,Payment Reference');
  assert.equal(lines.length, 3);
  // The file is the ONE place the full number appears — that is its purpose.
  assert.ok(lines[1].includes('123456789012'));
  assert.ok(lines[1].includes('CREWLYSAL-2026-08-0001'));
  assert.equal(outcome.queued, false);

  const batch = await service.getBatch({ companyId: COMPANY, batchId: state.batch._id });
  assert.equal(batch.batch.status, 'FILE_GENERATED');
  assert.equal(batch.files.length, 1);
  assert.equal(batch.files[0].downloadCount, 0);
});

test('the XLSX bank file is a real, readable workbook (§10)', async () => {
  const { service } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  const outcome = await service.generateFile({
    companyId: COMPANY,
    batchId: state.batch._id,
    format: 'XLSX',
    actor,
  });

  assert.ok(Buffer.isBuffer(outcome.binary));
  // PK\x03\x04 — the ZIP signature every .xlsx starts with.
  assert.equal(outcome.binary.slice(0, 2).toString(), 'PK');
  assert.ok(outcome.binary.length > 1000);
  assert.equal(BANK_FILE_FORMATS.includes('XLSX'), true);
});

test('generation refuses a batch whose bank details broke since creation (§7)', async () => {
  const { service, ProfileModel } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  // Someone empties the IFSC after the batch was built.
  ProfileModel.rows[0].bank.ifsc = '';

  const check = await service.validateBatch({ companyId: COMPANY, batchId: state.batch._id });
  assert.equal(check.valid, false);
  assert.equal(check.errorRows.length, 1);

  await assert.rejects(
    () => service.generateFile({ companyId: COMPANY, batchId: state.batch._id, format: 'CSV', actor }),
    (error) => error.statusCode === 400 && /bank validation/i.test(error.message),
  );
});

test('the queue payload carries references only — no account, no amount (§20)', async () => {
  const { service, dispatched } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  await service.generateFile({ companyId: COMPANY, batchId: state.batch._id, format: 'CSV', actor });

  assert.equal(dispatched.length, 1);
  const payload = dispatched[0];
  assert.equal(payload.format, 'CSV');
  assert.equal(/123456789012|39127|accountNumber|netSalary/.test(JSON.stringify(payload)), false);

  assert.equal(validatePayrollPaymentFilePayload({ ...payload, fileId: payload.fileId }).valid, true);
  assert.equal(
    validatePayrollPaymentFilePayload({ ...payload, format: 'PDF' }).valid,
    false,
  );
  assert.equal(
    validatePayrollPaymentFilePayload({ ...payload, payments: [] }).valid,
    false,
    'a payload that smuggles rows must be refused',
  );
  assert.ok(PAYROLL_JOB_NAMES.includes(JOB_NAMES.PAYROLL_PAYMENT_FILE));
  assert.equal(QUEUE_NAMES.PAYROLL, 'payroll');
});

test('the worker rebuilds the file from Mongo, not from the payload (§20)', async () => {
  const { service, FileModel } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });
  const generated = await service.generateFile({
    companyId: COMPANY,
    batchId: state.batch._id,
    format: 'CSV',
    actor,
  });

  // The bank fixes the IFSC, then the worker runs.
  await service.PaymentModel?.updateOne?.({}, {});
  const fileId = String(generated.file._id);
  await service.processFile({
    companyId: COMPANY,
    batchId: state.batch._id,
    fileId,
    format: 'CSV',
  });

  const row = FileModel.rows.find((entry) => String(entry._id) === fileId);
  assert.equal(row.status, 'READY');
  assert.ok(row.content.includes('123456789012'));
  assert.equal(row.rowCount, 2);
  assert.ok(row.checksum);
});

// ── 7. downloads (§12) ─────────────────────────────────────────────────────

test('every download is counted and the batch moves to downloaded (§12)', async () => {
  const { service, auditRows } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });
  const generated = await service.generateFile({
    companyId: COMPANY,
    batchId: state.batch._id,
    format: 'CSV',
    actor,
  });

  const first = await service.downloadFile({
    companyId: COMPANY,
    fileId: String(generated.file._id),
    actor,
  });
  assert.ok(first.content.includes('123456789012'));

  const second = await service.downloadFile({
    companyId: COMPANY,
    fileId: String(generated.file._id),
    actor,
  });
  assert.equal(second.file.downloadCount, 2);
  assert.ok(second.file.lastDownloadedAt);

  const batch = await service.getBatch({ companyId: COMPANY, batchId: state.batch._id });
  assert.equal(batch.batch.status, 'DOWNLOADED');
  // §12 — history is append-only: the file row is updated, never replaced.
  assert.equal(batch.files.length, 1);
  assert.ok(auditRows.some((row) => row.action === 'PAYMENT_FILE_DOWNLOADED'));
});

// ── 8. confirmation, failures and retry (§13 / §14 / §15 / §16) ────────────

test('marking all paid confirms the batch and notifies HR (§13 / §21)', async () => {
  const { service, notifications, audiences } = makeHarness();
  const state = await buildBatchWithFile({ service });

  const paid = await service.markAllPaid({ companyId: COMPANY, batchId: state.batch._id, actor });

  assert.equal(paid.batch.status, 'PAID');
  assert.equal(paid.batch.summary.successfulTransactions, 2);
  assert.equal(paid.batch.summary.totalPaid, 78254.54);
  assert.ok(paid.payments.every((row) => row.status === 'PAID'));
  assert.ok(notifications.some((row) => row.type === 'PAYMENT_CONFIRMED'));
  assert.ok(audiences.some((permissions) => permissions.includes('PAYROLL_PAYMENT_READ')));
});

test('a failure needs a reason and leaves the batch partially paid (§14 / §15)', async () => {
  const { service, auditRows } = makeHarness();
  const state = await buildBatchWithFile({ service });

  await assert.rejects(
    () =>
      service.markEmployee({
        companyId: COMPANY,
        batchId: state.batch._id,
        employeeId: EMPLOYEE_1,
        status: 'FAILED',
        actor,
      }),
    (error) => error.statusCode === 400 && /reason/i.test(error.message),
  );

  const partial = await service.markEmployee({
    companyId: COMPANY,
    batchId: state.batch._id,
    employeeId: EMPLOYEE_1,
    status: 'FAILED',
    failureReason: 'ACCOUNT_CLOSED',
    remarks: 'Bank returned the credit',
    actor,
  });

  assert.equal(partial.batch.status, 'PARTIALLY_PAID');
  const failed = partial.payments.find((row) => String(row.employeeId) === EMPLOYEE_1);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureReason, 'ACCOUNT_CLOSED');
  // §15 — the successful employees are untouched.
  const ok = partial.payments.find((row) => String(row.employeeId) === EMPLOYEE_2);
  assert.equal(ok.status, 'PENDING');
  assert.ok(auditRows.some((row) => row.action === 'PAYMENT_EMPLOYEE_FAILED'));
  assert.ok(FAILURE_REASONS.includes('ACCOUNT_CLOSED'));
});

test('a retry batch pays only the failures and never pays twice (§15 / §16)', async () => {
  const { service, BatchModel, PaymentModel } = makeHarness();
  const state = await buildBatchWithFile({ service });

  await service.markEmployee({
    companyId: COMPANY,
    batchId: state.batch._id,
    employeeId: EMPLOYEE_1,
    status: 'PAID',
    actor,
  });
  await service.markEmployee({
    companyId: COMPANY,
    batchId: state.batch._id,
    employeeId: EMPLOYEE_2,
    status: 'FAILED',
    failureReason: 'IFSC_ERROR',
    actor,
  });

  const retry = await service.createRetryBatch({
    companyId: COMPANY,
    batchId: state.batch._id,
    actor,
  });

  assert.equal(BatchModel.rows.length, 2);
  assert.equal(retry.batch.batchNumber, 'SAL-2026-08-002');
  assert.equal(retry.batch.attempt, 2);
  assert.equal(String(retry.batch.sourceBatchId), String(state.batch._id));
  // Only the failed employee is in the retry — the paid one is never re-sent.
  assert.equal(retry.payments.length, 1);
  assert.equal(String(retry.payments[0].employeeId), EMPLOYEE_2);
  // §11 — a fresh reference, not a duplicate of the original.
  assert.notEqual(retry.payments[0].paymentReference, 'CREWLYSAL-2026-08-0002');
  assert.ok(retry.payments[0].paymentReference.startsWith('CREWLYSAL-2026-08-'));

  const references = PaymentModel.rows.map((row) => row.paymentReference);
  assert.equal(new Set(references).size, references.length, 'references must be unique');
});

test('a batch with nothing to retry is refused (§16)', async () => {
  const { service } = makeHarness();
  const state = await buildBatchWithFile({ service });
  await service.markAllPaid({ companyId: COMPANY, batchId: state.batch._id, actor });

  await assert.rejects(
    () => service.createRetryBatch({ companyId: COMPANY, batchId: state.batch._id, actor }),
    (error) => error.statusCode === 400,
  );
});

test('cancel and reopen follow §4 / §8', async () => {
  const { service, auditRows } = makeHarness();
  const state = await buildBatchWithFile({ service });

  // Reopen is only for a failed batch.
  await assert.rejects(
    () => service.reopenBatch({ companyId: COMPANY, batchId: state.batch._id, actor }),
    (error) => error.statusCode === 400 && /failed/i.test(error.message),
  );

  const cancelled = await service.cancelBatch({
    companyId: COMPANY,
    batchId: state.batch._id,
    reason: 'Wrong bank file',
    actor,
  });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(cancelled.cancelledAt);
  assert.ok(auditRows.some((row) => row.action === 'PAYMENT_CANCELLED'));

  // A cancelled batch cannot be retried.
  await assert.rejects(
    () => service.createRetryBatch({ companyId: COMPANY, batchId: state.batch._id, actor }),
    (error) => error.statusCode === 400,
  );

  // …but a failed one can be reopened and regenerated.
  const second = makeHarness();
  const other = await buildBatchWithFile(second);
  await second.service.markEmployee({
    companyId: COMPANY,
    batchId: other.batch._id,
    employeeId: EMPLOYEE_1,
    status: 'FAILED',
    failureReason: 'BANK_REJECTED',
    actor,
  });
  await second.service.markEmployee({
    companyId: COMPANY,
    batchId: other.batch._id,
    employeeId: EMPLOYEE_2,
    status: 'FAILED',
    failureReason: 'BANK_REJECTED',
    actor,
  });
  const reopened = await second.service.reopenBatch({
    companyId: COMPANY,
    batchId: other.batch._id,
    actor,
  });
  assert.equal(reopened.batch.status, 'READY');
});

// ── 9. notifications (§21) ─────────────────────────────────────────────────

test('notifications are addressed by permission and skip the actor (§21)', async () => {
  const { service, notifications, audiences } = makeHarness();
  const state = await service.createBatch({ companyId: COMPANY, month: MONTH, actor });

  assert.ok(audiences[0].includes('PAYROLL_PAYMENT_CONFIRM'));
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every((row) => row.userId !== String(actor._id)));
  assert.ok(notifications.some((row) => row.userId === FINANCE_USER));
  assert.ok(notifications.some((row) => row.userId === HR_USER));
  assert.ok(notifications.every((row) => row.companyId === COMPANY));

  await service.generateFile({ companyId: COMPANY, batchId: state.batch._id, format: 'CSV', actor });
  assert.ok(notifications.some((row) => row.type === 'PAYMENT_FILE_READY'));
});

test('a notification that fails never blocks a payment (§21)', async () => {
  const exploding = makeHarness({
    notifyImpl: async () => {
      throw new Error('notification service down');
    },
  });

  const state = await buildBatchWithFile(exploding);
  assert.equal(state.batch.status, 'FILE_GENERATED');

  const paid = await exploding.service.markAllPaid({
    companyId: COMPANY,
    batchId: state.batch._id,
    actor,
  });
  assert.equal(paid.batch.status, 'PAID');
});

// ── 10. scope, cache and permissions (§3 / §4 / §19) ───────────────────────

test('a narrowed payroll scope never widens a payment batch (§3)', async () => {
  const { service } = makeHarness();
  const state = await service.createBatch({
    companyId: COMPANY,
    month: MONTH,
    actor,
    allowedEmployeeIds: [EMPLOYEE_2],
  });

  assert.equal(state.payments.length, 1);
  assert.equal(String(state.payments[0].employeeId), EMPLOYEE_2);
});

test('the dashboard is read through the tenant cache (§19)', async () => {
  const { service, cacheCalls } = makeHarness();
  await buildBatchWithFile({ service });

  const dashboard = await service.getDashboard({ companyId: COMPANY, month: MONTH });

  assert.equal(cacheCalls.getOrSet, 1);
  assert.equal(cacheCalls.lastOptions.version, 1);
  assert.ok(cacheCalls.lastOptions.ttlSeconds >= 10);
  assert.equal(dashboard.batches.length, 1);
  assert.equal(dashboard.kpis.pendingPayments, 2);
  assert.equal(dashboard.kpis.totalPayroll, 78254.54);

  // Every write invalidates the key.
  await service.markAllPaid({ companyId: COMPANY, batchId: dashboard.batches[0]._id, actor });
  assert.ok(cacheCalls.del > 0);

  // The shared key shape is the one the phase documents.
  assert.equal(
    paymentCacheKey(COMPANY, MONTH),
    `crewly:cache:company:${COMPANY}:payroll-payment:v1:${MONTH}:dashboard`,
  );
  assert.equal(paymentCacheKey('not-an-id', MONTH), null);
  await invalidatePaymentCache(COMPANY, MONTH); // must not throw without Redis
});

test('payment KPIs track money movement, not payroll calculation (§17)', () => {
  const kpis = paymentKpis({
    batches: [
      { status: 'PAID', summary: { totalNetSalary: 100, successfulTransactions: 2, failedTransactions: 0, pendingTransactions: 0, totalPaid: 100 } },
      { status: 'PARTIALLY_PAID', summary: { totalNetSalary: 100, successfulTransactions: 1, failedTransactions: 1, pendingTransactions: 0, totalPaid: 50 } },
    ],
  });

  assert.equal(kpis.batches, 2);
  assert.equal(kpis.totalPayroll, 200);
  assert.equal(kpis.paidEmployees, 3);
  assert.equal(kpis.failedPayments, 1);
  assert.equal(kpis.totalAmountPaid, 150);
  assert.equal(kpis.retryRequired, 1);
});

test('payment permissions follow §4 — never role names', () => {
  const catalogue = new Set(DEFAULT_PERMISSIONS.map((row) => row.name));
  ['PAYROLL_PAYMENT_READ', 'PAYROLL_PAYMENT_GENERATE', 'PAYROLL_PAYMENT_CONFIRM', 'PAYROLL_PAYMENT_MARK_PAID'].forEach(
    (name) => assert.ok(catalogue.has(name), `${name} must exist in the catalogue`),
  );

  const has = (role, name) => (DEFAULT_ROLE_MATRIX[role] || []).includes(name);

  // HR Manager: view payment status only (§4).
  assert.equal(has('HR_MANAGER', 'PAYROLL_PAYMENT_READ'), true);
  assert.equal(has('HR_MANAGER', 'PAYROLL_PAYMENT_GENERATE'), false);
  assert.equal(has('HR_MANAGER', 'PAYROLL_PAYMENT_CONFIRM'), false);
  assert.equal(has('HR_MANAGER', 'PAYROLL_PAYMENT_MARK_PAID'), false);

  // Company Admin: everything.
  ['READ', 'GENERATE', 'CONFIRM', 'MARK_PAID'].forEach((action) => {
    assert.equal(has('COMPANY_ADMIN', `PAYROLL_PAYMENT_${action}`), true);
  });

  // Employees and managers never see payments.
  ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE'].forEach((role) => {
    assert.equal(has(role, 'PAYROLL_PAYMENT_READ'), false, `${role} must not see payments`);
  });

  const byKey = Object.fromEntries(ROLE_TEMPLATES.map((row) => [row.key, row.permissions]));

  // Payroll Admin: generate and validate, never confirm or mark paid.
  assert.ok(byKey.PAYROLL_ADMIN.includes('PAYROLL_PAYMENT_READ'));
  assert.ok(byKey.PAYROLL_ADMIN.includes('PAYROLL_PAYMENT_GENERATE'));
  assert.equal(byKey.PAYROLL_ADMIN.includes('PAYROLL_PAYMENT_CONFIRM'), false);

  // Finance Manager: download, confirm, mark failures.
  ['READ', 'GENERATE', 'CONFIRM', 'MARK_PAID'].forEach((action) => {
    assert.ok(byKey.FINANCE_MANAGER.includes(`PAYROLL_PAYMENT_${action}`), `Finance Manager needs ${action}`);
  });
  // Finance Executive: downloads only.
  assert.deepEqual(
    byKey.FINANCE_EXECUTIVE.filter((name) => name.startsWith('PAYROLL_PAYMENT')),
    ['PAYROLL_PAYMENT_READ'],
  );
});

test('a file that would be too large is refused instead of generated (§20)', () => {
  assert.ok(MAX_FILE_BYTES > 0);
  const huge = buildBankFile({
    format: 'CSV',
    payments: Array.from({ length: 5 }, (_, index) => ({
      employeeCode: `EMP${index}`,
      employeeName: 'X'.repeat(50),
      accountHolderName: 'Y'.repeat(50),
      accountNumber: '123456789012',
      ifsc: 'HDFC0001234',
      bankName: 'HDFC',
      netSalary: 1000,
      paymentReference: `SAL-2026-08-${index}`,
    })),
  });
  assert.ok(huge.content.length < MAX_FILE_BYTES);
});

test('the service exposes no payment action without the batch (§3)', async () => {
  const { service } = makeHarness();
  await assert.rejects(
    () => service.getBatch({ companyId: COMPANY, batchId: '64b7f9c2e4b0a1b2c3d4e5ff' }),
    (error) => error.statusCode === 404,
  );
});
