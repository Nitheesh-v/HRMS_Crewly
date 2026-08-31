// Hermetic suite for Phase 29.2 — Salary Components.
// No MongoDB, no Redis, no network: the service is instantiated with a
// fake model, a fake cache and a fake audit writer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const [rules, serviceFactory, registry, templates] = await Promise.all([
  import('../src/services/payroll/salaryComponentRules.js'),
  import('../src/services/payroll/salaryComponentService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/roleTemplates.js'),
]);

const {
  CALCULATION_TYPES,
  COMPONENT_CATEGORIES,
  buildDependencyGraph,
  describeCalculation,
  detectCircularDependency,
  filterComponents,
  normalizeSalaryComponent,
  suggestDefaultComponents,
  validateSalaryComponent,
} = rules;
const { makeSalaryComponentService } = serviceFactory;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;

// ── fakes ──────────────────────────────────────────────────────────────────

// Minimal in-memory stand-in for the Mongoose model. Every query the
// service issues is companyId-scoped, so tenant isolation is observable
// through these rows.
const makeFakeModel = () => {
  const rows = [];
  let counter = 0;

  const clone = (row) => ({ ...row });
  const same = (a, b) => String(a) === String(b);
  const match = (row, filter = {}) =>
    Object.entries(filter).every(([key, value]) => same(row[key], value));

  const makeDoc = (row) => ({
    ...clone(row),
    toObject: () => clone(row),
    save: async function save() {
      const index = rows.findIndex((candidate) => candidate._id === row._id);
      for (const [key, value] of Object.entries(this)) {
        if (key === 'toObject' || key === 'save' || key === '_id') continue;
        row[key] = value;
      }
      if (index >= 0) rows[index] = row;
      return this;
    },
  });

  return {
    rows,
    seed: (row) => {
      const stored = { version: 1, isCurrent: true, status: 'ACTIVE', ...row };
      rows.push(stored);
      return stored;
    },
    find: (filter = {}) => ({
      sort: () => ({
        lean: async () => rows.filter((row) => match(row, filter)).map(clone),
      }),
    }),
    findOne: (filter = {}) => {
      const locate = () => rows.find((row) => match(row, filter)) || null;
      const api = {
        lean: async () => {
          const row = locate();
          return row ? clone(row) : null;
        },
        select: () => ({ lean: api.lean }),
        then: (resolve, reject) => {
          const row = locate();
          return Promise.resolve(row ? makeDoc(row) : null).then(resolve, reject);
        },
      };
      return api;
    },
    create: async (data) => {
      counter += 1;
      const stored = {
        _id: `component-${counter}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.push(stored);
      return makeDoc(stored);
    },
  };
};

const makeHarness = ({ onAudit, onCache } = {}) => {
  const SalaryComponentModel = makeFakeModel();
  const PayrollSetupModel = {
    findOne: () => ({
      select: () => ({
        lean: async () => ({ statutory: { pf: { applicable: true }, esi: { applicable: false } } }),
      }),
    }),
  };

  const cacheCalls = { getOrSet: 0, del: 0 };
  const auditRows = [];

  const cache = {
    buildKey: ({ companyId, namespace }) => `test:${companyId}:${namespace}`,
    getOrSet: async (key, options) => {
      cacheCalls.getOrSet += 1;
      if (onCache) await onCache(key, options);
      return { value: await options.loader(), cache: 'MISS' };
    },
    del: async () => {
      cacheCalls.del += 1;
      return true;
    },
  };

  const audit = async (row) => {
    auditRows.push(row);
    if (onAudit) await onAudit(row);
  };

  const service = makeSalaryComponentService({
    SalaryComponentModel,
    PayrollSetupModel,
    cache,
    audit,
  });

  return { service, SalaryComponentModel, cacheCalls, auditRows };
};

const COMPONENT_A = 'company-a';
const COMPONENT_B = 'company-b';

// ── domain rules ───────────────────────────────────────────────────────────

test('normalization trims, upper-cases the code and drops unknown fields', () => {
  const normalized = normalizeSalaryComponent({
    name: '  House Rent Allowance  ',
    code: 'hra-allowance',
    category: 'earning',
    calculationType: 'percentage',
    percentage: 40,
    calculationBase: 'basic',
    isSystemDefault: true,
    companyId: 'smuggled',
  });

  assert.equal(normalized.name, 'House Rent Allowance');
  assert.equal(normalized.code, 'HRA_ALLOWANCE');
  assert.equal(normalized.category, 'EARNING');
  assert.equal(normalized.calculationType, 'PERCENTAGE');
  assert.equal(normalized.calculationBase, 'BASIC');
  assert.equal(normalized.isSystemDefault, false, 'client cannot claim system-default status');
  assert.equal(normalized.companyId, undefined, 'tenant is never taken from the payload');
});

test('the model vocabulary covers earnings, deductions and employer contributions', () => {
  assert.deepEqual(COMPONENT_CATEGORIES, ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION']);
  assert.ok(CALCULATION_TYPES.includes('FIXED_AMOUNT'));
  assert.ok(CALCULATION_TYPES.includes('PERCENTAGE'));
  assert.ok(CALCULATION_TYPES.includes('FORMULA'));
});

test('validation rejects missing names, bad codes and incomplete percentage rules', () => {
  const missing = validateSalaryComponent(normalizeSalaryComponent({}));
  assert.ok(missing.some((error) => error.field === 'name'));
  assert.ok(missing.some((error) => error.field === 'code'));

  const badCode = validateSalaryComponent(
    normalizeSalaryComponent({ name: 'Bonus', code: 'bo nus!', category: 'EARNING' }),
  );
  assert.ok(badCode.some((error) => error.field === 'code'));

  const pct = validateSalaryComponent(
    normalizeSalaryComponent({
      name: 'HRA',
      code: 'HRA',
      calculationType: 'PERCENTAGE',
      percentage: 40,
    }),
  );
  assert.ok(pct.some((error) => error.field === 'calculationBase'));
});

test('percentage bounds and self-dependency are rejected (47)', () => {
  const outOfRange = validateSalaryComponent(
    normalizeSalaryComponent({
      name: 'HRA',
      code: 'HRA',
      calculationType: 'PERCENTAGE',
      percentage: 5000,
      calculationBase: 'BASIC',
    }),
  );
  assert.ok(outOfRange.some((error) => error.field === 'percentage'));

  const selfDep = validateSalaryComponent(
    normalizeSalaryComponent({
      name: 'HRA',
      code: 'HRA',
      calculationType: 'PERCENTAGE',
      percentage: 40,
      calculationBase: 'COMPONENT',
      dependsOnCode: 'HRA',
    }),
  );
  assert.ok(selfDep.some((error) => error.field === 'dependsOnCode'));
  assert.equal(selfDep[0].message, 'This component cannot depend on itself');
});

test('duplicate tenant-level codes are rejected with an HR-friendly message', () => {
  const errors = validateSalaryComponent(
    normalizeSalaryComponent({ name: 'Provident Fund', code: 'PF', category: 'DEDUCTION' }),
    { existingCodes: ['PF', 'HRA'] },
  );
  assert.equal(errors[0].field, 'code');
  assert.equal(errors[0].message, 'This component code is already in use. Please choose another code.');

  // the same code on a different tenant is fine
  const otherTenant = validateSalaryComponent(
    normalizeSalaryComponent({ name: 'Provident Fund', code: 'PF', category: 'DEDUCTION' }),
    { existingCodes: ['HRA'] },
  );
  assert.equal(otherTenant.length, 0);
});

test('circular dependencies are detected and rejected (14 / 47)', () => {
  const basic = normalizeSalaryComponent({ name: 'Basic', code: 'BASIC', calculationType: 'FIXED_AMOUNT' });
  const hra = normalizeSalaryComponent({
    name: 'HRA',
    code: 'HRA',
    calculationType: 'PERCENTAGE',
    percentage: 40,
    calculationBase: 'COMPONENT',
    dependsOnCode: 'BASIC',
  });

  assert.equal(detectCircularDependency(hra, [basic]), null, 'HRA -> Basic is fine');

  // Now Basic would depend on HRA: Basic -> HRA -> Basic
  const cyclicBasic = normalizeSalaryComponent({
    name: 'Basic',
    code: 'BASIC',
    calculationType: 'PERCENTAGE',
    percentage: 10,
    calculationBase: 'COMPONENT',
    dependsOnCode: 'HRA',
  });
  const cycle = detectCircularDependency(cyclicBasic, [basic, hra]);
  assert.ok(cycle, 'cycle must be detected');
  assert.ok(cycle.includes('BASIC') && cycle.includes('HRA'));

  // three-hop cycle A -> B -> C -> A
  const graph = buildDependencyGraph([
    { code: 'A', calculationType: 'PERCENTAGE', calculationBase: 'COMPONENT', dependsOnCode: 'B' },
    { code: 'B', calculationType: 'PERCENTAGE', calculationBase: 'COMPONENT', dependsOnCode: 'C' },
    { code: 'C', calculationType: 'PERCENTAGE', calculationBase: 'COMPONENT', dependsOnCode: 'A' },
  ]);
  assert.ok(rules.findDependencyCycle(graph, 'A'));
});

test('calculation preview reads like HR expects it to (30)', () => {
  const codeToName = { BASIC: 'Basic Salary' };
  assert.equal(
    describeCalculation(
      { calculationType: 'PERCENTAGE', percentage: 40, calculationBase: 'BASIC' },
      codeToName,
    ),
    '40% of Basic Salary',
  );
  assert.equal(
    describeCalculation(
      { calculationType: 'PERCENTAGE', percentage: 40, calculationBase: 'COMPONENT', dependsOnCode: 'BASIC' },
      codeToName,
    ),
    '40% of Basic Salary',
  );
  assert.equal(
    describeCalculation({ calculationType: 'FIXED_AMOUNT', defaultAmount: 2000 }, codeToName),
    'Fixed ₹2,000',
  );
});

test('formula storage is a controlled operation list, never an expression (45)', () => {
  const normalized = normalizeSalaryComponent({
    name: 'Special',
    code: 'SPECIAL',
    calculationType: 'FORMULA',
    formula: {
      base: 'GROSS',
      operations: [
        { operator: 'ADD', componentCode: 'BASIC' },
        { operator: 'SUBTRACT', componentCode: 'LOP' },
        { operator: 'eval', componentCode: 'process.exit(1)' },
      ],
    },
  });

  assert.equal(normalized.formula.operations.length, 2, 'non-whitelisted operators are dropped');
  assert.ok(normalized.formula.operations.every((op) => ['ADD', 'SUBTRACT'].includes(op.operator)));
  assert.ok(!JSON.stringify(normalized).includes('process.exit'));
});

// ── statutory defaults (35 / 36) ───────────────────────────────────────────

test('default suggestions follow the Phase 29.1 statutory configuration', () => {
  const withPf = suggestDefaultComponents({ pf: { applicable: true }, esi: { applicable: false } });
  const codes = withPf.map((component) => component.code);

  assert.ok(codes.includes('PF'));
  assert.ok(codes.includes('EMPLOYER_PF'));
  assert.ok(!codes.includes('ESI'), 'ESI is switched off in payroll setup, so it is never forced');

  const withEsi = suggestDefaultComponents({ pf: { applicable: true }, esi: { applicable: true } });
  const esiCodes = withEsi.map((component) => component.code);
  assert.ok(esiCodes.includes('ESI'));
  assert.ok(esiCodes.includes('EMPLOYER_ESI'));

  // employee deduction and employer contribution stay distinct (19)
  const pf = withPf.find((component) => component.code === 'PF');
  const employerPf = withPf.find((component) => component.code === 'EMPLOYER_PF');
  assert.equal(pf.category, 'DEDUCTION');
  assert.equal(employerPf.category, 'EMPLOYER_CONTRIBUTION');
});

// ── listing, filtering and search (26 / 27) ────────────────────────────────

test('filters and search work and the result is paginated', () => {
  const components = [
    { name: 'Basic Salary', code: 'BASIC', category: 'EARNING', status: 'ACTIVE', description: '' },
    { name: 'House Rent Allowance', code: 'HRA', category: 'EARNING', status: 'ACTIVE', description: 'rent' },
    { name: 'Provident Fund', code: 'PF', category: 'DEDUCTION', status: 'INACTIVE', description: '' },
  ];

  const all = filterComponents(components, {});
  assert.equal(all.meta.total, 3);

  const earnings = filterComponents(components, { category: 'EARNING' });
  assert.equal(earnings.items.length, 2);

  const active = filterComponents(components, { status: 'ACTIVE' });
  assert.equal(active.items.length, 2);

  const searched = filterComponents(components, { search: 'rent' });
  assert.equal(searched.items.length, 1);
  assert.equal(searched.items[0].code, 'HRA');

  const paged = filterComponents(components, { limit: 2, page: 2 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.meta.pages, 2);
});

// ── service: create ────────────────────────────────────────────────────────

test('create stores the tenant, invalidates the cache and writes an audit row', async () => {
  const { service, SalaryComponentModel, cacheCalls, auditRows } = makeHarness();

  const created = await service.createComponent({
    companyId: COMPONENT_A,
    payload: {
      name: 'Basic Salary',
      code: 'BASIC',
      category: 'EARNING',
      calculationType: 'FIXED_AMOUNT',
      defaultAmount: 30000,
    },
    actor: { _id: 'user-1' },
  });

  assert.equal(String(created.companyId), COMPONENT_A);
  assert.equal(SalaryComponentModel.rows.length, 1);
  assert.equal(cacheCalls.del, 1, 'cache is invalidated after a write');
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'SALARY_COMPONENT_CREATED');
  assert.equal(String(auditRows[0].companyId), COMPONENT_A);
  assert.equal(auditRows[0].newValue.code, 'BASIC');
});

test('create rejects a duplicate active name but allows the same name once inactive', async () => {
  const { service } = makeHarness();

  await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'Bonus', code: 'BONUS', category: 'EARNING' },
  });

  await assert.rejects(
    () =>
      service.createComponent({
        companyId: COMPONENT_A,
        payload: { name: 'bonus', code: 'BONUS2', category: 'EARNING' },
      }),
    /already exists/i,
  );

  // deactivate, then the name is free again
  const { components } = await service.listComponents({ companyId: COMPONENT_A });
  await service.setStatus({ companyId: COMPONENT_A, componentId: components[0]._id, status: 'INACTIVE' });

  const reused = await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'bonus', code: 'BONUS2', category: 'EARNING' },
  });
  assert.equal(reused.code, 'BONUS2');
});

test('changing an existing dependency into a cycle is rejected (14 / 47)', async () => {
  const { service } = makeHarness();

  const basic = await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'Basic', code: 'BASIC', calculationType: 'FIXED_AMOUNT' },
  });
  await service.createComponent({
    companyId: COMPONENT_A,
    payload: {
      name: 'HRA',
      code: 'HRA',
      calculationType: 'PERCENTAGE',
      percentage: 40,
      calculationBase: 'COMPONENT',
      dependsOnCode: 'BASIC',
    },
  });

  // Making Basic depend on HRA would close Basic -> HRA -> Basic.
  await assert.rejects(
    () =>
      service.updateComponent({
        companyId: COMPONENT_A,
        componentId: basic._id,
        payload: {
          calculationType: 'PERCENTAGE',
          percentage: 10,
          calculationBase: 'COMPONENT',
          dependsOnCode: 'HRA',
        },
      }),
    /circular salary dependency/i,
  );
});

test('a brand new component can never be part of an existing cycle', async () => {
  const { service } = makeHarness();

  await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'Basic', code: 'BASIC', calculationType: 'FIXED_AMOUNT' },
  });

  // Nothing points at SPECIAL yet, so this is always safe.
  const created = await service.createComponent({
    companyId: COMPONENT_A,
    payload: {
      name: 'Special Allowance',
      code: 'SPECIAL',
      calculationType: 'PERCENTAGE',
      percentage: 10,
      calculationBase: 'COMPONENT',
      dependsOnCode: 'BASIC',
    },
  });
  assert.equal(created.code, 'SPECIAL');
});

// ── service: tenant isolation ──────────────────────────────────────────────

test('company B cannot see or touch company A components', async () => {
  const { service } = makeHarness();

  await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'Basic', code: 'BASIC' },
  });
  await service.createComponent({
    companyId: COMPONENT_B,
    payload: { name: 'Basic', code: 'BASIC', category: 'DEDUCTION' },
  });

  const listA = await service.listComponents({ companyId: COMPONENT_A });
  assert.equal(listA.components.length, 1);
  assert.equal(listA.components[0].category, 'EARNING', 'only company A rows are returned');

  const listB = await service.listComponents({ companyId: COMPONENT_B });
  assert.equal(listB.components.length, 1);
  assert.equal(listB.components[0].category, 'DEDUCTION');

  // cross-tenant read by id returns not-found
  const [onlyA] = listA.components;
  const crossTenant = await service.getComponent({ companyId: COMPONENT_B, componentId: onlyA._id });
  assert.equal(crossTenant, null);

  // the same code is legal in two different tenants
  assert.equal(listA.components[0].code, listB.components[0].code);
});

// ── service: cache behaviour ───────────────────────────────────────────────

test('a Redis failure never blocks reads or writes (40)', async () => {
  const { service } = makeHarness({
    onCache: () => {
      throw new Error('redis down');
    },
  });

  await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'Basic', code: 'BASIC' },
  });

  const result = await service.listComponents({ companyId: COMPONENT_A });
  assert.equal(result.components.length, 1, 'MongoDB remains the source of truth');
});

// ── service: update + versioning ───────────────────────────────────────────

test('an unused component updates in place and records the previous state', async () => {
  const { service, auditRows } = makeHarness();

  const created = await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'HRA', code: 'HRA', calculationType: 'FIXED_AMOUNT', defaultAmount: 5000 },
  });

  const { component, versioned } = await service.updateComponent({
    companyId: COMPONENT_A,
    componentId: created._id,
    payload: { defaultAmount: 8000 },
  });

  assert.equal(versioned, false);
  assert.equal(component.defaultAmount, 8000);

  const updateRow = auditRows.find((row) => row.action === 'SALARY_COMPONENT_UPDATED');
  assert.equal(updateRow.previousValue.defaultAmount, 5000);
  assert.equal(updateRow.newValue.defaultAmount, 8000);
});

test('a component with history gets a NEW version instead of rewriting it (24 / 58)', async () => {
  const { service, SalaryComponentModel } = makeHarness();

  // seed a component that already has history behind it
  const seeded = SalaryComponentModel.seed({
    _id: 'seeded-1',
    companyId: COMPONENT_A,
    name: 'HRA',
    code: 'HRA',
    category: 'EARNING',
    calculationType: 'PERCENTAGE',
    percentage: 40,
    calculationBase: 'BASIC',
    taxability: 'TAXABLE',
    version: 3,
    isCurrent: true,
  });

  const { component, versioned } = await service.updateComponent({
    companyId: COMPONENT_A,
    componentId: seeded._id,
    payload: { percentage: 50 },
  });

  assert.equal(versioned, true);
  assert.equal(component.version, 4);
  assert.equal(component.percentage, 50);
  assert.equal(String(component.previousVersionId), seeded._id);

  // the old row is closed, not mutated
  const previous = SalaryComponentModel.rows.find((row) => row._id === seeded._id);
  assert.equal(previous.isCurrent, false);
  assert.equal(previous.percentage, 40, 'historical percentage is untouched');
  assert.ok(previous.effectiveTo, 'previous version is closed with an effective date');
});

// ── service: lifecycle ─────────────────────────────────────────────────────

test('deactivate keeps the component for history and reactivation re-enables it (21 / 33 / 34)', async () => {
  const { service, SalaryComponentModel, auditRows } = makeHarness();

  const created = await service.createComponent({
    companyId: COMPONENT_A,
    payload: { name: 'Bonus', code: 'BONUS' },
  });

  const deactivated = await service.setStatus({
    companyId: COMPONENT_A,
    componentId: created._id,
    status: 'INACTIVE',
  });
  assert.equal(deactivated.component.status, 'INACTIVE');
  assert.equal(SalaryComponentModel.rows.length, 1, 'deactivation is never a delete (21)');

  const reactivated = await service.setStatus({
    companyId: COMPONENT_A,
    componentId: created._id,
    status: 'ACTIVE',
  });
  assert.equal(reactivated.component.status, 'ACTIVE');

  const actions = auditRows.map((row) => row.action);
  assert.ok(actions.includes('SALARY_COMPONENT_DEACTIVATED'));
  assert.ok(actions.includes('SALARY_COMPONENT_ACTIVATED'));

  // inactive components disappear from the default "active" filter
  await service.setStatus({ companyId: COMPONENT_A, componentId: created._id, status: 'INACTIVE' });
  const inactiveList = await service.listComponents({ companyId: COMPONENT_A, query: { status: 'ACTIVE' } });
  assert.equal(inactiveList.components.length, 0);
});

test('duplicate makes a fresh component with its own code and no history (32)', async () => {
  const { service } = makeHarness();

  const source = await service.createComponent({
    companyId: COMPONENT_A,
    payload: {
      name: 'Night Shift Allowance',
      code: 'NIGHT_SHIFT',
      calculationType: 'FIXED_AMOUNT',
      defaultAmount: 500,
    },
  });

  const copy = await service.duplicateComponent({
    companyId: COMPONENT_A,
    componentId: source._id,
    payload: { name: 'Weekend Shift Allowance', code: 'WEEKEND_SHIFT' },
  });

  assert.equal(copy.code, 'WEEKEND_SHIFT');
  assert.equal(copy.name, 'Weekend Shift Allowance');
  assert.equal(copy.version, 1);
  assert.equal(copy.previousVersionId, null, 'no history is copied');
  assert.equal(copy.defaultAmount, 500, 'configuration is copied');

  await assert.rejects(
    () =>
      service.duplicateComponent({
        companyId: COMPONENT_A,
        componentId: source._id,
        payload: { name: 'Another', code: 'NIGHT_SHIFT' },
      }),
    /already in use/i,
  );
});

// ── permissions ────────────────────────────────────────────────────────────

test('salary component permissions exist and are separated by duty', () => {
  const names = new Set(DEFAULT_PERMISSIONS.map((permission) => permission.name));

  assert.ok(names.has('SALARY_COMPONENT_READ'));
  assert.ok(names.has('SALARY_COMPONENT_MANAGE'));
  assert.ok(names.has('SALARY_COMPONENT_ACTIVATE'));

  const hrManager = new Set(DEFAULT_ROLE_MATRIX.HR_MANAGER || []);
  assert.ok(hrManager.has('SALARY_COMPONENT_READ'));
  assert.ok(hrManager.has('SALARY_COMPONENT_MANAGE'));
  assert.ok(!hrManager.has('SALARY_COMPONENT_ACTIVATE'), 'activation is a separate duty');

  for (const role of ['EMPLOYEE', 'MANAGER', 'TEAM_LEAD']) {
    const perms = new Set(DEFAULT_ROLE_MATRIX[role] || []);
    assert.ok(!perms.has('SALARY_COMPONENT_READ'), `${role} must not see components`);
    assert.ok(!perms.has('SALARY_COMPONENT_MANAGE'), `${role} must not manage components`);
  }
});

test('role templates only grant component permissions that exist', () => {
  const names = new Set(DEFAULT_PERMISSIONS.map((permission) => permission.name));

  for (const template of templates.ROLE_TEMPLATES) {
    for (const permission of template.permissions) {
      if (permission.startsWith('SALARY_COMPONENT')) {
        assert.ok(names.has(permission), `${template.key} references unknown ${permission}`);
      }
    }
  }

  const payrollAdmin = templates.findRoleTemplate('PAYROLL_ADMIN');
  assert.ok(payrollAdmin.permissions.includes('SALARY_COMPONENT_ACTIVATE'));

  const payrollExecutive = templates.findRoleTemplate('PAYROLL_EXECUTIVE');
  assert.ok(payrollExecutive.permissions.includes('SALARY_COMPONENT_READ'));
  assert.ok(!payrollExecutive.permissions.includes('SALARY_COMPONENT_MANAGE'));
});

test('permission version was bumped for the new component lifecycle permission', async () => {
  const source = await readFile(new URL('../src/utils/permissionService.js', import.meta.url), 'utf8');
  const version = Number(source.match(/SYSTEM_PERMISSION_VERSION\s*=\s*(\d+)/)?.[1]);
  assert.ok(version >= 16, `expected migration version >= 16, got ${version}`);
});

// ── route wiring ───────────────────────────────────────────────────────────

test('routes are permission-gated and mounted under /api/payroll/components', async () => {
  const [routes, index] = await Promise.all([
    readFile(new URL('../src/routes/salaryComponentRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/index.js', import.meta.url), 'utf8'),
  ]);

  assert.match(index, /router\.use\("\/payroll\/components", salaryComponentRoutes\)/);
  assert.match(routes, /requirePermission\('SALARY_COMPONENT_READ'\)/);
  assert.match(routes, /requirePermission\('SALARY_COMPONENT_MANAGE'\)/);
  assert.match(routes, /requirePermission\('SALARY_COMPONENT_ACTIVATE'\)/);
  assert.match(routes, /requireFeature\('payroll'\)/);
  assert.ok(!/companyId/.test(routes.match(/router\.[a-z]+\([^)]*\)/g)?.join('') || ''), 'no companyId in paths');
});
