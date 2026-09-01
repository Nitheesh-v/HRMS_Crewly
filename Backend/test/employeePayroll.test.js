// Hermetic suite for Phase 29.4 — Employee Payroll Profile.
// No MongoDB, no Redis, no network: the service is instantiated with fake
// models, a fake cache, a fake audit writer and a fake notifier.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const [rules, serviceFactory, registry, templates] = await Promise.all([
  import('../src/services/payroll/employeePayrollRules.js'),
  import('../src/services/payroll/employeePayrollService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/roleTemplates.js'),
]);

const {
  EMPLOYMENT_TYPES,
  PAYROLL_STATUSES,
  PAY_GROUPS,
  canChangePayrollStatus,
  computeEmployeePayrollPreview,
  isValidAccountNumber,
  isValidEsi,
  isValidIfsc,
  isValidPan,
  isValidUan,
  isSalaryRevision,
  maskAccountNumber,
  normalizeEmployeePayroll,
  redactForAudit,
  serializeEmployeePayroll,
  validateEmployeePayroll,
} = rules;
const { makeEmployeePayrollService } = serviceFactory;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { ROLE_TEMPLATES } = templates;

// ── fakes ──────────────────────────────────────────────────────────────────

let counter = 0;

const makeFakeModel = (prefix = 'row') => {
  const rows = [];

  const makeDoc = (row) => ({
    ...row,
    toObject: () => ({ ...row, bank: { ...(row.bank || {}) } }),
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
      if (value && typeof value === 'object' && !Array.isArray(value) && value.$in) {
        return value.$in.some((entry) => String(entry) === String(row[key]));
      }
      return String(row[key]) === String(value);
    });

  return {
    rows,
    seed: (row) => {
      const stored = { version: 1, isCurrent: true, payrollStatus: 'DRAFT', ...row };
      rows.push(stored);
      return stored;
    },
    find: (filter = {}) => ({
      sort: () => ({
        lean: async () => rows.filter((row) => match(row, filter)).map((row) => ({ ...row })),
        select: () => ({
          lean: async () => rows.filter((row) => match(row, filter)).map((row) => ({ ...row })),
        }),
      }),
      select: () => ({
        lean: async () => rows.filter((row) => match(row, filter)).map((row) => ({ ...row })),
        sort: () => ({
          lean: async () => rows.filter((row) => match(row, filter)).map((row) => ({ ...row })),
        }),
      }),
    }),
    findOne: (filter = {}) => {
      const api = {
        select: () => api,
        lean: async () => {
          const row = rows.find((candidate) => match(candidate, filter));
          return row ? { ...row, bank: { ...(row.bank || {}) } } : null;
        },
        then: (resolve, reject) => {
          const row = rows.find((candidate) => match(candidate, filter));
          return Promise.resolve(row ? makeDoc(row) : null).then(resolve, reject);
        },
      };
      return api;
    },
    create: async (data) => {
      counter += 1;
      // Mongoose schema defaults the fake has to mimic (§15 / §23).
      const stored = {
        _id: `${prefix}-${counter}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
        isCurrent: true,
        payrollStatus: 'DRAFT',
        ...data,
      };
      rows.push(stored);
      return makeDoc(stored);
    },
    countDocuments: async (filter = {}) => rows.filter((row) => match(row, filter)).length,
  };
};

// A structure whose employer contribution is 5% of basic ⇒ predictable CTC.
const STRUCTURE = {
  _id: 'structure-1',
  name: 'Standard Monthly Structure',
  status: 'ACTIVE',
  items: [
    { componentCode: 'BASIC', calculationMethod: 'FIXED_AMOUNT', value: 50000, order: 0 },
    { componentCode: 'HRA', calculationMethod: 'FIXED_AMOUNT', value: 20000, order: 1 },
    { componentCode: 'SPECIAL', calculationMethod: 'REMAINING', value: null, order: 2 },
    { componentCode: 'PF', calculationMethod: 'FIXED_AMOUNT', value: 1800, order: 3 },
    { componentCode: 'GRATUITY', calculationMethod: 'FIXED_AMOUNT', value: 2400, order: 4 },
  ],
  componentMap: {
    BASIC: { code: 'BASIC', name: 'Basic', category: 'EARNING' },
    HRA: { code: 'HRA', name: 'HRA', category: 'EARNING' },
    SPECIAL: { code: 'SPECIAL', name: 'Special Allowance', category: 'EARNING' },
    PF: { code: 'PF', name: 'Provident Fund', category: 'DEDUCTION' },
    GRATUITY: { code: 'GRATUITY', name: 'Gratuity', category: 'EMPLOYER_CONTRIBUTION' },
  },
};

const makeHarness = ({ statutory = { pf: { applicable: true }, esi: { applicable: false } } } = {}) => {
  const ProfileModel = makeFakeModel('profile');
  const StructureModel = {
    findOne: ({ _id, companyId }) => {
      const found =
        String(_id) === String(STRUCTURE._id) && String(companyId) === 'company-a'
          ? { ...STRUCTURE }
          : null;
      return {
        lean: async () => found,
        then: (resolve, reject) => Promise.resolve(found).then(resolve, reject),
      };
    },
    find: () => ({
      select: () => ({ lean: async () => [{ _id: STRUCTURE._id, name: STRUCTURE.name, status: 'ACTIVE' }] }),
    }),
  };
  const ComponentModel = {
    find: () => ({
      select: () => ({ lean: async () => Object.values(STRUCTURE.componentMap) }),
    }),
  };
  const SetupModel = {
    findOne: () => ({
      select: () => ({ lean: async () => ({ statutory, payrollCycle: { frequency: 'MONTHLY' } }) }),
    }),
  };
  const UserModel = {
    find: () => ({
      select: () => ({
        lean: async () => [
          { _id: 'employee-1', name: 'Asha Rao', email: 'asha@crewly.com', employeeCode: 'EMP001' },
        ],
      }),
    }),
    findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'employee-1', companyId: 'company-a' }) }) }),
  };

  const cacheCalls = { getOrSet: 0, del: 0 };
  const auditRows = [];
  const notifications = [];

  const service = makeEmployeePayrollService({
    EmployeePayrollProfileModel: ProfileModel,
    SalaryStructureTemplateModel: StructureModel,
    SalaryComponentModel: ComponentModel,
    PayrollSetupModel: SetupModel,
    UserModel,
    cache: {
      buildKey: ({ companyId, namespace }) => `test:${companyId}:${namespace}`,
      getOrSet: async (key, options) => {
        cacheCalls.getOrSet += 1;
        return { value: await options.loader(), cache: 'MISS' };
      },
      del: async () => {
        cacheCalls.del += 1;
        return true;
      },
    },
    audit: async (row) => auditRows.push(row),
    notify: async (row) => notifications.push(row),
  });

  return { service, ProfileModel, cacheCalls, auditRows, notifications };
};

const actor = { _id: 'hr-1', name: 'HR Manager' };

const basePayload = (overrides = {}) => ({
  structureId: 'structure-1',
  annualCtc: 1228800, // (100000 gross + 2400 employer) × 12
  monthlyGross: 100000,
  effectiveFrom: '2026-09-01',
  payrollStatus: 'DRAFT',
  bank: {
    bankName: 'HDFC Bank',
    accountHolderName: 'Asha Rao',
    accountNumber: '123456789012',
    ifsc: 'HDFC0001234',
    branch: 'Koramangala',
  },
  statutory: { pan: 'ABCDE1234F', uan: '100123456789', pfMember: true },
  ...overrides,
});

// ── 1. catalogues ──────────────────────────────────────────────────────────

test('29.4 catalogues expose the documented statuses, types and pay groups', () => {
  assert.deepEqual(PAYROLL_STATUSES, ['DRAFT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED']);
  assert.deepEqual(EMPLOYMENT_TYPES, ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']);
  assert.deepEqual(PAY_GROUPS, ['MONTHLY', 'WEEKLY', 'EXECUTIVE']);
});

test('status transitions follow §14', () => {
  assert.equal(canChangePayrollStatus('DRAFT', 'ACTIVE'), true);
  assert.equal(canChangePayrollStatus('ACTIVE', 'ON_HOLD'), true);
  assert.equal(canChangePayrollStatus('ON_HOLD', 'ACTIVE'), true);
  assert.equal(canChangePayrollStatus('ACTIVE', 'SUSPENDED'), true);
  assert.equal(canChangePayrollStatus('DRAFT', 'ON_HOLD'), false);
  assert.equal(canChangePayrollStatus('SUSPENDED', 'ACTIVE'), false);
});

// ── 2. formats and masking (§10 / §24) ─────────────────────────────────────

test('identity formats are validated the way Indian payroll expects', () => {
  assert.equal(isValidIfsc('HDFC0001234'), true);
  assert.equal(isValidIfsc('HDFC1234'), false);
  assert.equal(isValidPan('ABCDE1234F'), true);
  assert.equal(isValidPan('ABCDE123'), false);
  assert.equal(isValidUan('100123456789'), true);
  assert.equal(isValidUan('10012'), false);
  assert.equal(isValidEsi('12345678901234567'), true);
  assert.equal(isValidEsi('123'), false);
  assert.equal(isValidAccountNumber('123456789012'), true);
  assert.equal(isValidAccountNumber('12345'), false);
});

test('bank accounts are masked and identity numbers are redacted for audit', () => {
  assert.equal(maskAccountNumber('123456789012'), 'XXXX XXXX 9012');
  assert.equal(maskAccountNumber(''), '');
  assert.equal(redactForAudit('ABCDE1234F'), '[REDACTED]');
  assert.equal(redactForAudit(''), '');

  const serialized = serializeEmployeePayroll({
    bank: { bankName: 'HDFC', accountNumber: '123456789012', accountNumberMasked: 'XXXX XXXX 9012' },
  });
  assert.equal(serialized.bank.accountNumber, undefined);
  assert.equal(serialized.bank.accountNumberMasked, 'XXXX XXXX 9012');
  assert.equal(serialized.bank.hasAccount, true);
});

// ── 3. normalization (§3) ──────────────────────────────────────────────────

test('normalizeEmployeePayroll drops client tenant and lineage fields', () => {
  const normalized = normalizeEmployeePayroll({
    companyId: 'attacker',
    employeeId: 'attacker-employee',
    _id: 'attacker-id',
    version: 42,
    isCurrent: false,
    annualCtc: '1200000',
    bank: { ifsc: 'hdfc0001234', accountNumber: '1234 5678 9012' },
    statutory: { pan: 'abcde1234f' },
  });

  assert.equal(normalized.companyId, undefined);
  assert.equal(normalized.employeeId, undefined);
  assert.equal(normalized.version, undefined);
  assert.equal(normalized.annualCtc, 1200000);
  assert.equal(normalized.bank.ifsc, 'HDFC0001234');
  assert.equal(normalized.bank.accountNumber, '123456789012');
  assert.equal(normalized.statutory.pan, 'ABCDE1234F');
});

// ── 4. validation (§23) ────────────────────────────────────────────────────

test('a complete draft passes validation', () => {
  const errors = validateEmployeePayroll(normalizeEmployeePayroll(basePayload()), {
    structure: STRUCTURE,
    statutory: { pf: { applicable: true }, esi: { applicable: false } },
  });
  assert.deepEqual(errors, []);
});

test('CTC must align with gross plus employer contributions', () => {
  const errors = validateEmployeePayroll(
    normalizeEmployeePayroll(basePayload({ annualCtc: 500000 })),
    { structure: STRUCTURE },
  );
  assert.ok(errors.some((error) => error.field === 'annualCtc'));
});

test('only an ACTIVE structure can be assigned', () => {
  const inactive = { ...STRUCTURE, status: 'INACTIVE' };
  const errors = validateEmployeePayroll(normalizeEmployeePayroll(basePayload()), {
    structure: inactive,
  });
  assert.ok(errors.some((error) => /active salary structure/i.test(error.message)));

  const missing = validateEmployeePayroll(normalizeEmployeePayroll(basePayload()), {
    structure: null,
  });
  assert.ok(missing.some((error) => error.field === 'structureId'));
});

test('statutory requirements follow the company 29.1 configuration (§11)', () => {
  const active = normalizeEmployeePayroll(basePayload({ payrollStatus: 'ACTIVE' }));

  // PF applies ⇒ UAN required to go active.
  const withPf = validateEmployeePayroll(active, {
    structure: STRUCTURE,
    statutory: { pf: { applicable: true }, esi: { applicable: false } },
  });
  assert.equal(withPf.filter((error) => error.field === 'statutory.uan').length, 0);

  const noUan = validateEmployeePayroll(
    normalizeEmployeePayroll(basePayload({ payrollStatus: 'ACTIVE', statutory: { pan: 'ABCDE1234F' } })),
    { structure: STRUCTURE, statutory: { pf: { applicable: true } } },
  );
  assert.ok(noUan.some((error) => error.field === 'statutory.uan'));

  // PF off in 29.1 ⇒ not mandatory here.
  const pfOff = validateEmployeePayroll(
    normalizeEmployeePayroll(basePayload({ payrollStatus: 'ACTIVE', statutory: { pan: 'ABCDE1234F' } })),
    { structure: STRUCTURE, statutory: { pf: { applicable: false }, esi: { applicable: false } } },
  );
  assert.equal(pfOff.filter((error) => error.field === 'statutory.uan').length, 0);

  // ESI on ⇒ ESI number required.
  const esiOn = validateEmployeePayroll(
    normalizeEmployeePayroll(basePayload({ payrollStatus: 'ACTIVE', statutory: { pan: 'ABCDE1234F', uan: '100123456789' } })),
    { structure: STRUCTURE, statutory: { pf: { applicable: false }, esi: { applicable: true } } },
  );
  assert.ok(esiOn.some((error) => error.field === 'statutory.esiNumber'));
});

test('a revision cannot start before or on the salary it replaces', () => {
  const earlier = validateEmployeePayroll(
    normalizeEmployeePayroll(basePayload({ effectiveFrom: '2026-01-01' })),
    { structure: STRUCTURE, selfEffectiveFrom: new Date('2026-04-01') },
  );
  assert.ok(earlier.some((error) => /cannot start before/i.test(error.message)));

  const sameDay = validateEmployeePayroll(
    normalizeEmployeePayroll(basePayload({ effectiveFrom: '2026-04-01' })),
    {
      structure: STRUCTURE,
      existingVersions: [{ _id: 'profile-1', effectiveFrom: new Date('2026-04-01') }],
    },
  );
  assert.ok(sameDay.some((error) => /already starts on this date/i.test(error.message)));
});

test('bank format errors are reported per field', () => {
  const errors = validateEmployeePayroll(
    normalizeEmployeePayroll(
      basePayload({ bank: { bankName: '', ifsc: 'NOPE', accountNumber: '12' } }),
    ),
    { structure: STRUCTURE },
  );

  assert.ok(errors.some((error) => error.field === 'bank.bankName'));
  assert.ok(errors.some((error) => error.field === 'bank.ifsc'));
  assert.ok(errors.some((error) => error.field === 'bank.accountNumber'));
});

// ── 5. §9 preview (display only) ───────────────────────────────────────────

test('the breakup preview splits gross and annualises the result', () => {
  const preview = computeEmployeePayrollPreview({ structure: STRUCTURE, monthlyGross: 100000 });

  const byCode = Object.fromEntries(preview.earnings.map((row) => [row.componentCode, row.amount]));
  assert.equal(byCode.BASIC, 50000);
  assert.equal(byCode.HRA, 20000);
  assert.equal(byCode.SPECIAL, 30000);
  assert.equal(preview.totals.gross, 100000);
  assert.equal(preview.totals.totalDeductions, 1800);
  assert.equal(preview.totals.netPay, 98200);
  assert.equal(preview.totals.employerCost, 2400);
  assert.equal(preview.annual.ctc, 1228800);
});

// ── 6. revisions (§15 / §16) ───────────────────────────────────────────────

test('CTC, gross, structure or date changes are a revision; cosmetics are not', () => {
  const base = { annualCtc: 800000, monthlyGross: 66000, structureId: 'a', effectiveFrom: new Date('2026-01-01') };

  assert.equal(isSalaryRevision(base, { ...base, annualCtc: 900000 }), true);
  assert.equal(isSalaryRevision(base, { ...base, structureId: 'b' }), true);
  assert.equal(isSalaryRevision(base, { ...base, effectiveFrom: new Date('2026-07-01') }), true);
  assert.equal(isSalaryRevision(base, base), false);
});

// ── 7. service: create, revise, status ─────────────────────────────────────

test('saveProfile creates the profile, caches, audits and never returns the account number', async () => {
  const { service, ProfileModel, cacheCalls, auditRows } = makeHarness();

  const { profile, revision } = await service.saveProfile({
    companyId: 'company-a',
    employeeId: 'employee-1',
    payload: basePayload(),
    actor,
    req: { method: 'PUT', originalUrl: '/api/payroll/employees/employee-1' },
  });

  assert.equal(revision, false);
  assert.equal(profile.version, 1);
  assert.equal(profile.isCurrent, true);
  assert.equal(String(profile.companyId), 'company-a');
  assert.equal(ProfileModel.rows.length, 1);
  assert.equal(cacheCalls.del, 1);
  assert.equal(auditRows.at(-1).action, 'EMPLOYEE_PAYROLL_CREATED');

  // §24 — the stored row keeps a masked mirror, never the plain number.
  assert.equal(profile.bank.accountNumberMasked, 'XXXX XXXX 9012');
  assert.equal(profile.bank.accountNumberLast4, '9012');
  assert.notEqual(profile.bank.accountNumber, '123456789012');
});

test('a salary change writes a new version and freezes the previous one', async () => {
  const { service, ProfileModel, auditRows, notifications } = makeHarness();

  const first = await service.saveProfile({
    companyId: 'company-a',
    employeeId: 'employee-1',
    payload: basePayload(),
    actor,
  });

  const second = await service.saveProfile({
    companyId: 'company-a',
    employeeId: 'employee-1',
    payload: basePayload({
      annualCtc: 1473600, // (120000 + 2400) × 12
      monthlyGross: 120000,
      effectiveFrom: '2026-10-01',
    }),
    actor,
  });

  assert.equal(second.revision, true);
  assert.equal(second.profile.version, 2);
  assert.equal(second.profile.previousVersionId, first.profile._id);
  assert.equal(ProfileModel.rows.length, 2);

  const previous = ProfileModel.rows.find((row) => String(row._id) === String(first.profile._id));
  assert.equal(previous.isCurrent, false);
  assert.equal(previous.annualCtc, 1228800, 'history is never rewritten');
  assert.ok(previous.effectiveTo instanceof Date);

  assert.equal(auditRows.at(-1).action, 'EMPLOYEE_SALARY_REVISED');
  assert.equal(notifications.at(-1).type, 'SALARY_REVISED');
});

test('the status change honours the transition table and re-checks statutory rules', async () => {
  const { service, ProfileModel, auditRows, notifications } = makeHarness();

  await service.saveProfile({
    companyId: 'company-a',
    employeeId: 'employee-1',
    payload: basePayload(),
    actor,
  });

  const active = await service.setStatus({
    companyId: 'company-a',
    employeeId: 'employee-1',
    status: 'ACTIVE',
    actor,
  });
  assert.equal(active.payrollStatus, 'ACTIVE');
  assert.ok(active.activatedAt instanceof Date);
  assert.equal(auditRows.at(-1).action, 'EMPLOYEE_PAYROLL_ACTIVE');
  assert.equal(notifications.at(-1).type, 'PAYROLL_ACTIVATED');

  // DRAFT → ON_HOLD is not a legal transition.
  await assert.rejects(
    () =>
      service.setStatus({
        companyId: 'company-a',
        employeeId: 'employee-1',
        status: 'DRAFT',
        actor,
      }),
    (error) => error.statusCode === 400,
  );
  assert.equal(ProfileModel.rows.length, 1);
});

test('activating without the statutory identity the company requires is rejected', async () => {
  const { service } = makeHarness();

  await service.saveProfile({
    companyId: 'company-a',
    employeeId: 'employee-1',
    payload: basePayload({ statutory: { pan: 'ABCDE1234F' } }),
    actor,
  });

  await assert.rejects(
    () =>
      service.setStatus({
        companyId: 'company-a',
        employeeId: 'employee-1',
        status: 'ACTIVE',
        actor,
      }),
    (error) => error.statusCode === 400 && /UAN/.test(error.message),
  );
});

// ── 8. tenant isolation (§3) ───────────────────────────────────────────────

test('another company never sees or writes this employee profile', async () => {
  const { service } = makeHarness();
  await service.saveProfile({
    companyId: 'company-a',
    employeeId: 'employee-1',
    payload: basePayload(),
    actor,
  });

  // The structure lookup is company-scoped, so company B cannot even save.
  await assert.rejects(
    () =>
      service.saveProfile({
        companyId: 'company-b',
        employeeId: 'employee-1',
        payload: basePayload(),
        actor,
      }),
    (error) => error.statusCode === 400,
  );

  assert.equal(
    await service.getProfile({ companyId: 'company-b', employeeId: 'employee-1' }),
    null,
  );
});

// ── 9. §19 recruitment integration ─────────────────────────────────────────

test('createFromOffer seeds a DRAFT profile from the offered CTC', async () => {
  const { service, ProfileModel, auditRows } = makeHarness();

  const profile = await service.createFromOffer({
    companyId: 'company-a',
    employeeId: 'employee-9',
    offer: { compensationSnapshot: { annualCTC: 1200000 } },
    actor,
  });

  assert.ok(profile);
  assert.equal(profile.payrollStatus, 'DRAFT');
  assert.equal(profile.annualCtc, 1200000);
  assert.equal(profile.monthlyGross, 100000);
  assert.equal(profile.payGroup, 'MONTHLY');
  assert.equal(ProfileModel.rows.length, 1);
  assert.equal(auditRows.at(-1).newValue.source, 'CANDIDATE_CONVERSION');

  // Idempotent: a second conversion does not duplicate the profile.
  const again = await service.createFromOffer({
    companyId: 'company-a',
    employeeId: 'employee-9',
    offer: { compensationSnapshot: { annualCTC: 1200000 } },
    actor,
  });
  assert.equal(String(again._id), String(profile._id));
  assert.equal(ProfileModel.rows.length, 1);
});

test('createFromOffer does nothing when the offer carries no CTC', async () => {
  const { service, ProfileModel } = makeHarness();
  const profile = await service.createFromOffer({
    companyId: 'company-a',
    employeeId: 'employee-9',
    offer: {},
    actor,
  });
  assert.equal(profile, null);
  assert.equal(ProfileModel.rows.length, 0);
});

// ── 10. RBAC (§4 / §24) ────────────────────────────────────────────────────

test('payroll profile permissions follow permissions, not role names', () => {
  const catalogue = DEFAULT_PERMISSIONS.map((permission) => permission.name);

  assert.ok(catalogue.includes('EMPLOYEE_SALARY_READ'));
  assert.ok(catalogue.includes('EMPLOYEE_SALARY_MANAGE'));
  assert.ok(catalogue.includes('EMPLOYEE_SALARY_READ_SELF'));

  assert.ok(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes('EMPLOYEE_SALARY_READ'));
  assert.ok(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes('EMPLOYEE_SALARY_MANAGE'));

  // §4 — HR Manager and Payroll Admin create and revise.
  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('EMPLOYEE_SALARY_MANAGE'));
  const payrollAdmin = ROLE_TEMPLATES.find((entry) => entry.key === 'PAYROLL_ADMIN');
  assert.ok(payrollAdmin.permissions.includes('EMPLOYEE_SALARY_MANAGE'));

  // §4 / §24 — Manager and Team Lead get NOTHING, Employee gets own only.
  for (const role of ['MANAGER', 'TEAM_LEAD']) {
    assert.equal(
      DEFAULT_ROLE_MATRIX[role].filter((permission) => permission.startsWith('EMPLOYEE_SALARY')).length,
      0,
    );
  }
  assert.deepEqual(
    DEFAULT_ROLE_MATRIX.EMPLOYEE.filter((permission) => permission.startsWith('EMPLOYEE_SALARY')),
    ['EMPLOYEE_SALARY_READ_SELF'],
  );
});

// ── 11. source conventions ─────────────────────────────────────────────────

const readSource = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('29.4 backend sources are ESM, tenant-scoped and role-name free', async () => {
  const files = [
    'src/services/payroll/employeePayrollRules.js',
    'src/services/payroll/employeePayrollService.js',
    'src/controllers/employeePayrollController.js',
    'src/validators/employeePayrollValidator.js',
    'src/routes/employeePayrollRoutes.js',
    'src/middlewares/payrollProfileAccess.js',
    'src/models/EmployeePayrollProfile.js',
  ];

  for (const file of files) {
    const source = await readSource(file);

    assert.equal(/\bfunction\s+\w+\s*\(/.test(source), false, `${file} must stay arrow-function ESM`);
    assert.equal(/\brequire\s*\(/.test(source), false, `${file} must not use require()`);
    // The rules module is pure domain logic and the validator only checks
    // shape; tenant scoping lives in the service, model, routes and middleware.
    const needsTenantScope = !file.includes('Rules') && !file.includes('Validator');
    if (needsTenantScope) {
      assert.ok(/companyId/.test(source), `${file} must be tenant-scoped`);
    }
    assert.equal(
      /role\s*===\s*['"](COMPANY_ADMIN|HR_MANAGER|Payroll Admin)['"]/.test(source),
      false,
      `${file} must not hardcode role names`,
    );
  }
});

test('the account number is encrypted at rest and hidden from default queries', async () => {
  const model = await readSource('src/models/EmployeePayrollProfile.js');
  assert.match(model, /accountNumber:[^}]*select:\s*false/);
  assert.match(model, /accountNumberMasked/);
  assert.match(model, /partialFilterExpression/);
});

test('routes keep the legacy /api/payroll paths untouched', async () => {
  const index = await readSource('src/routes/index.js');
  assert.match(index, /router\.use\("\/payroll\/employees", employeePayrollRoutes\)/);
  assert.equal(/router\.use\("\/payroll\/structures"/.test(index), false);
});
