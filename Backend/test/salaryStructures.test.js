// Hermetic suite for Phase 29.3 — Salary Structures.
// No MongoDB, no Redis, no network: the service is instantiated with fake
// models, a fake cache and a fake audit writer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const [rules, serviceFactory, componentFactory, registry, templates] = await Promise.all([
  import('../src/services/payroll/salaryStructureRules.js'),
  import('../src/services/payroll/salaryStructureService.js'),
  import('../src/services/payroll/salaryComponentService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/roleTemplates.js'),
]);

const {
  CALCULATION_METHODS,
  STRUCTURE_STATUSES,
  canTransition,
  cloneStructurePayload,
  computeStructurePreview,
  filterStructures,
  normalizeSalaryStructure,
  validateAgainstGross,
  validateSalaryStructure,
} = rules;
const { makeSalaryStructureService } = serviceFactory;
const { makeSalaryComponentService } = componentFactory;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { ROLE_TEMPLATES } = templates;

// ── fakes ──────────────────────────────────────────────────────────────────

let counter = 0;

const cloneRow = (row) => ({
  ...row,
  items: (row.items || []).map((item) => ({ ...item })),
});

// Minimal in-memory stand-in for the Mongoose model. Every query the service
// issues is companyId-scoped, so tenant isolation is observable here.
const makeFakeModel = (prefix = 'row') => {
  const rows = [];

  // 'items.componentCode' must reach inside the items array.
  const readPath = (row, path) =>
    path.split('.').reduce((acc, key) => {
      if (Array.isArray(acc)) return acc.map((entry) => (entry == null ? entry : entry[key]));
      return acc == null ? acc : acc[key];
    }, row);

  const match = (row, filter = {}) =>
    Object.entries(filter).every(([key, value]) => {
      const actual = readPath(row, key);
      if (Array.isArray(actual)) return actual.some((entry) => String(entry) === String(value));
      return String(actual) === String(value);
    });

  const makeDoc = (row) => ({
    ...cloneRow(row),
    toObject: () => cloneRow(row),
    save: async function save() {
      for (const [key, value] of Object.entries(this)) {
        if (key === 'toObject' || key === 'save' || key === '_id') continue;
        row[key] = value;
      }
      return this;
    },
  });

  return {
    rows,
    seed: (row) => {
      const stored = { version: 1, isCurrent: true, status: 'DRAFT', ...row };
      rows.push(stored);
      return stored;
    },
    find: (filter = {}) => ({
      sort: () => ({
        lean: async () => rows.filter((row) => match(row, filter)).map(cloneRow),
        select: () => ({
          lean: async () => rows.filter((row) => match(row, filter)).map(cloneRow),
        }),
      }),
    }),
    findOne: (filter = {}) => {
      const locate = () => rows.find((row) => match(row, filter)) || null;
      const api = {
        lean: async () => {
          const row = locate();
          return row ? cloneRow(row) : null;
        },
        select: () => ({ lean: api.lean }),
        then: (resolve, reject) =>
          Promise.resolve(locate() ? makeDoc(locate()) : null).then(resolve, reject),
      };
      return api;
    },
    countDocuments: async (filter = {}) => rows.filter((row) => match(row, filter)).length,
    create: async (data) => {
      counter += 1;
      const stored = {
        _id: `${prefix}-${counter}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.push(stored);
      return makeDoc(stored);
    },
  };
};

const COMPONENTS = {
  BASIC: { code: 'BASIC', name: 'Basic Salary', category: 'EARNING' },
  HRA: { code: 'HRA', name: 'House Rent Allowance', category: 'EARNING' },
  SPECIAL: { code: 'SPECIAL', name: 'Special Allowance', category: 'EARNING' },
  PF: { code: 'PF', name: 'Provident Fund', category: 'DEDUCTION' },
  PT: { code: 'PT', name: 'Professional Tax', category: 'DEDUCTION' },
  GRATUITY: { code: 'GRATUITY', name: 'Gratuity', category: 'EMPLOYER_CONTRIBUTION' },
};

const makeComponentModel = (companyId) => ({
  find: (filter = {}) => ({
    sort: () => ({
      lean: async () =>
        String(filter.companyId) === String(companyId)
          ? Object.values(COMPONENTS).map((component) => ({ ...component, companyId }))
          : [],
    }),
  }),
});

const makeHarness = ({ companyId = 'company-a' } = {}) => {
  const SalaryStructureModel = makeFakeModel('structure');
  const SalaryComponentModel = makeComponentModel(companyId);
  const cacheCalls = { getOrSet: 0, del: 0 };
  const auditRows = [];

  const cache = {
    buildKey: ({ companyId: id, namespace }) => `test:${id}:${namespace}`,
    getOrSet: async (key, options) => {
      cacheCalls.getOrSet += 1;
      return { value: await options.loader(), cache: 'MISS' };
    },
    del: async () => {
      cacheCalls.del += 1;
      return true;
    },
  };

  const audit = async (row) => {
    auditRows.push(row);
  };

  const service = makeSalaryStructureService({
    SalaryStructureModel,
    SalaryComponentModel,
    cache,
    audit,
  });

  return { service, SalaryStructureModel, cacheCalls, auditRows, companyId };
};

const actor = { _id: 'user-1', name: 'Company Admin' };

const baseItems = () => [
  { componentCode: 'BASIC', calculationMethod: 'PERCENTAGE_OF_GROSS', value: 40, order: 0 },
  { componentCode: 'HRA', calculationMethod: 'PERCENTAGE_OF_BASIC', value: 50, order: 1 },
  { componentCode: 'SPECIAL', calculationMethod: 'REMAINING', value: null, order: 2 },
  { componentCode: 'PF', calculationMethod: 'PERCENTAGE_OF_BASIC', value: 12, order: 3 },
  { componentCode: 'GRATUITY', calculationMethod: 'PERCENTAGE_OF_BASIC', value: 4.81, order: 4 },
];

const basePayload = (overrides = {}) => ({
  name: 'Standard Structure',
  code: 'STD-2026',
  description: 'Default monthly structure',
  items: baseItems(),
  ...overrides,
});

// ── 1. catalogues ──────────────────────────────────────────────────────────

test('29.3 catalogues expose the documented statuses and methods', () => {
  assert.deepEqual(STRUCTURE_STATUSES, ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']);
  assert.deepEqual(CALCULATION_METHODS, [
    'FIXED_AMOUNT',
    'PERCENTAGE_OF_GROSS',
    'PERCENTAGE_OF_BASIC',
    'PERCENTAGE_OF_CTC',
    'REMAINING',
  ]);
});

// ── 2. normalization ───────────────────────────────────────────────────────

test('normalizeSalaryStructure drops client-supplied tenant and lineage fields', () => {
  const normalized = normalizeSalaryStructure({
    companyId: 'attacker-company',
    _id: 'attacker-id',
    version: 99,
    isCurrent: false,
    previousVersionId: 'attacker-prev',
    createdBy: 'attacker-user',
    name: '  Standard Structure  ',
    code: 'std-2026',
    items: [{ componentCode: 'basic', calculationMethod: 'fixed_amount', value: '25000' }],
  });

  assert.equal(normalized.companyId, undefined);
  assert.equal(normalized._id, undefined);
  assert.equal(normalized.version, undefined);
  assert.equal(normalized.isCurrent, undefined);
  assert.equal(normalized.previousVersionId, undefined);
  assert.equal(normalized.name, 'Standard Structure');
  assert.equal(normalized.code, 'STD_2026');
  assert.equal(normalized.items[0].componentCode, 'BASIC');
  assert.equal(normalized.items[0].value, 25000);
});

test('normalizeSalaryStructure forces REMAINING value to null', () => {
  const normalized = normalizeSalaryStructure({
    items: [{ componentCode: 'BASIC', calculationMethod: 'REMAINING', value: 500 }],
  });
  assert.equal(normalized.items[0].value, null);
});

// ── 3. validation (§10) ────────────────────────────────────────────────────

test('validation rejects a structure with no earning', () => {
  const errors = validateSalaryStructure(
    normalizeSalaryStructure({
      name: 'Deductions only',
      code: 'DED',
      items: [{ componentCode: 'PF', calculationMethod: 'FIXED_AMOUNT', value: 100 }],
    }),
    { components: COMPONENTS },
  );
  assert.ok(errors.some((error) => /at least one earning/i.test(error.message)));
});

test('validation rejects duplicate components, unknown components and bad percentages', () => {
  const structure = normalizeSalaryStructure({
    name: 'Broken',
    code: 'BROKEN',
    items: [
      { componentCode: 'BASIC', calculationMethod: 'PERCENTAGE_OF_GROSS', value: 150 },
      { componentCode: 'BASIC', calculationMethod: 'FIXED_AMOUNT', value: 100 },
      { componentCode: 'GHOST', calculationMethod: 'FIXED_AMOUNT', value: 100 },
    ],
  });

  const errors = validateSalaryStructure(structure, { components: COMPONENTS });
  const messages = errors.map((error) => error.message).join(' | ');

  assert.match(messages, /percentage must be between/i);
  assert.match(messages, /more than once/i);
  assert.match(messages, /not an active salary component/i);
});

test('validation allows only one REMAINING and only on an earning', () => {
  const twoRemaining = validateSalaryStructure(
    normalizeSalaryStructure({
      name: 'Two remaining',
      code: 'TWO_REM',
      items: [
        { componentCode: 'BASIC', calculationMethod: 'REMAINING' },
        { componentCode: 'HRA', calculationMethod: 'REMAINING' },
      ],
    }),
    { components: COMPONENTS },
  );
  assert.ok(twoRemaining.some((error) => /only one earning can use Remaining/i.test(error.message)));

  const deductionRemaining = validateSalaryStructure(
    normalizeSalaryStructure({
      name: 'PF remaining',
      code: 'PF_REM',
      items: [
        { componentCode: 'BASIC', calculationMethod: 'FIXED_AMOUNT', value: 100 },
        { componentCode: 'PF', calculationMethod: 'REMAINING' },
      ],
    }),
    { components: COMPONENTS },
  );
  assert.ok(
    deductionRemaining.some((error) => /only an earning can use Remaining/i.test(error.message)),
  );
});

test('validation rejects a structure code already used inside the same company', () => {
  const structure = normalizeSalaryStructure(basePayload({ code: 'STD-2026' }));
  const errors = validateSalaryStructure(structure, {
    components: COMPONENTS,
    existingCodes: ['STD-2026', 'OTHER'],
    selfCode: '',
  });
  assert.ok(errors.some((error) => error.field === 'code'));

  // ...but the same code is fine for the structure being edited.
  assert.equal(
    validateSalaryStructure(structure, {
      components: COMPONENTS,
      existingCodes: ['STD-2026'],
      selfCode: 'STD-2026',
    }).filter((error) => error.field === 'code').length,
    0,
  );
});

test('validateAgainstGross blocks earnings that exceed the sample gross', () => {
  const items = normalizeSalaryStructure({
    items: [
      { componentCode: 'BASIC', calculationMethod: 'FIXED_AMOUNT', value: 40000 },
      { componentCode: 'SPECIAL', calculationMethod: 'REMAINING' },
    ],
  }).items;

  assert.equal(validateAgainstGross(items, COMPONENTS, 50000).length, 0);
  assert.equal(validateAgainstGross(items, COMPONENTS, 30000).length, 1);
});

// ── 4. §9 preview (pure, never stored) ─────────────────────────────────────

test('preview distributes gross, fills the remaining earning and adds employer cost to CTC', () => {
  const preview = computeStructurePreview({
    items: normalizeSalaryStructure({
      items: [
        { componentCode: 'BASIC', calculationMethod: 'FIXED_AMOUNT', value: 24000, order: 0 },
        { componentCode: 'HRA', calculationMethod: 'FIXED_AMOUNT', value: 12000, order: 1 },
        { componentCode: 'SPECIAL', calculationMethod: 'REMAINING', order: 2 },
        { componentCode: 'PF', calculationMethod: 'FIXED_AMOUNT', value: 1800, order: 3 },
        { componentCode: 'GRATUITY', calculationMethod: 'FIXED_AMOUNT', value: 1154, order: 4 },
      ],
    }).items,
    components: COMPONENTS,
    gross: 60000,
  });

  const byCode = Object.fromEntries(preview.earnings.map((line) => [line.componentCode, line.amount]));

  assert.equal(byCode.BASIC, 24000);
  assert.equal(byCode.HRA, 12000);
  assert.equal(byCode.SPECIAL, 24000); // 60000 - (24000 + 12000)
  assert.equal(preview.totals.gross, 60000);
  assert.equal(preview.totals.basic, 24000);
  assert.equal(preview.totals.totalDeductions, 1800);
  assert.equal(preview.totals.netPay, 58200);
  assert.equal(preview.totals.employerCost, 1154);
  assert.equal(preview.totals.ctc, 61154);
  assert.equal(preview.totals.remaining, 24000);
  assert.equal(preview.deductions.length, 1);
  assert.equal(preview.employerContributions.length, 1);
});

test('preview resolves PERCENTAGE_OF_BASIC from the basic earning', () => {
  const preview = computeStructurePreview({
    items: normalizeSalaryStructure({
      items: [
        { componentCode: 'BASIC', calculationMethod: 'PERCENTAGE_OF_GROSS', value: 50, order: 0 },
        { componentCode: 'HRA', calculationMethod: 'PERCENTAGE_OF_BASIC', value: 40, order: 1 },
        { componentCode: 'SPECIAL', calculationMethod: 'REMAINING', order: 2 },
      ],
    }).items,
    components: COMPONENTS,
    gross: 50000,
  });

  const byCode = Object.fromEntries(preview.earnings.map((line) => [line.componentCode, line.amount]));
  assert.equal(byCode.BASIC, 25000);
  assert.equal(byCode.HRA, 10000);
  assert.equal(byCode.SPECIAL, 15000);
});

// ── 5. lifecycle (§5 / §14) ────────────────────────────────────────────────

test('structure lifecycle follows the documented transitions', () => {
  assert.equal(canTransition('DRAFT', 'ACTIVE'), true);
  assert.equal(canTransition('ACTIVE', 'INACTIVE'), true);
  assert.equal(canTransition('INACTIVE', 'ACTIVE'), true);
  assert.equal(canTransition('DRAFT', 'INACTIVE'), false);
  assert.equal(canTransition('ARCHIVED', 'ACTIVE'), false);
});

// ── 6. clone (§13) ─────────────────────────────────────────────────────────

test('clone copies configuration only and resets identity, version and history', () => {
  const cloned = cloneStructurePayload(
    {
      name: 'Standard Structure',
      code: 'STD-2026',
      status: 'ACTIVE',
      version: 4,
      isCurrent: false,
      previousVersionId: 'structure-1',
      items: baseItems(),
    },
    { name: 'Contractor Structure', code: 'contractor-2026' },
  );

  assert.equal(cloned.status, 'DRAFT');
  assert.equal(cloned.version, 1);
  assert.equal(cloned.isCurrent, true);
  assert.equal(cloned.previousVersionId, null);
  assert.equal(cloned.name, 'Contractor Structure');
  assert.equal(cloned.code, 'CONTRACTOR_2026');
  assert.equal(cloned.items.length, baseItems().length);
});

test('clone defaults the code and name when the caller sends nothing', () => {
  const cloned = cloneStructurePayload({ name: 'Standard Structure', code: 'STD-2026', items: [] });
  assert.equal(cloned.name, 'Standard Structure Copy');
  assert.equal(cloned.code, 'STD_2026_COPY');
});

// ── 7. listing / filters (§15) ────────────────────────────────────────────

test('filters narrow by status, department and free text', () => {
  const rows = [
    { name: 'Standard', code: 'STD', status: 'ACTIVE', departmentId: 'dept-1', effectiveFrom: '2026-01-01' },
    { name: 'Contractor', code: 'CNT', status: 'DRAFT', departmentId: 'dept-2', effectiveFrom: '2026-01-01' },
  ];

  assert.equal(filterStructures(rows, { status: 'ACTIVE' }).items.length, 1);
  assert.equal(filterStructures(rows, { departmentId: 'dept-2' }).items[0].code, 'CNT');
  assert.equal(filterStructures(rows, { search: 'cont' }).items.length, 1);
  assert.equal(filterStructures(rows, {}).meta.total, 2);
  assert.equal(filterStructures(rows, { page: 2, limit: 1 }).items[0].code, 'CNT');
});

// ── 8. service: create, audit, cache ───────────────────────────────────────

test('createStructure stores the structure, invalidates cache and writes an audit row', async () => {
  const { service, SalaryStructureModel, cacheCalls, auditRows, companyId } = makeHarness();

  const created = await service.createStructure({
    companyId,
    payload: basePayload(),
    actor,
    req: { method: 'POST', originalUrl: '/api/payroll/structures' },
  });

  assert.equal(String(created.companyId), companyId);
  assert.equal(created.version, 1);
  assert.equal(created.isCurrent, true);
  assert.equal(created.status, 'DRAFT');
  assert.equal(created.items.length, 5);
  assert.equal(cacheCalls.del, 1);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'SALARY_STRUCTURE_CREATED');
  assert.equal(String(auditRows[0].companyId), companyId);
  assert.equal(SalaryStructureModel.rows.length, 1);
});

test('createStructure rejects a duplicate code inside the same company', async () => {
  const { service, companyId } = makeHarness();
  await service.createStructure({ companyId, payload: basePayload(), actor });
  await assert.rejects(
    () => service.createStructure({ companyId, payload: basePayload(), actor }),
    (error) => error.statusCode === 400 && /already in use/i.test(error.message),
  );
});

test('createStructure rejects a component that does not exist in this company', async () => {
  const { service, companyId } = makeHarness();
  await assert.rejects(
    () =>
      service.createStructure({
        companyId,
        payload: basePayload({
          code: 'GHOST',
          items: [{ componentCode: 'GHOST', calculationMethod: 'FIXED_AMOUNT', value: 100 }],
        }),
        actor,
      }),
    (error) => error.statusCode === 400,
  );
});

// ── 9. tenant isolation (§3) ───────────────────────────────────────────────

test('a company never sees or touches another company structure', async () => {
  const { service, companyId } = makeHarness();
  await service.createStructure({ companyId, payload: basePayload(), actor });

  const other = makeHarness({ companyId: 'company-b' });
  await other.service.createStructure({
    companyId: 'company-b',
    payload: basePayload({ code: 'OTHER-2026' }),
    actor,
  });

  const listed = await service.listStructures({ companyId, query: {} });
  assert.equal(listed.structures.length, 1);
  assert.equal(listed.structures[0].code, 'STD_2026');

  // Cross-tenant reads and writes behave as "not found", never as leakage.
  assert.equal(await service.getStructure({ companyId, structureId: 'structure-2' }), null);
  await assert.rejects(
    () => service.updateStructure({ companyId, structureId: 'structure-2', payload: {}, actor }),
    (error) => error.statusCode === 404,
  );
});

// ── 10. update + versioning (§12) ──────────────────────────────────────────

test('editing a structure with no history updates it in place', async () => {
  const { service, SalaryStructureModel, companyId } = makeHarness();
  const created = await service.createStructure({ companyId, payload: basePayload(), actor });

  const { structure, versioned } = await service.updateStructure({
    companyId,
    structureId: created._id,
    payload: { name: 'Standard Structure v2' },
    actor,
  });

  assert.equal(versioned, false);
  assert.equal(structure.name, 'Standard Structure v2');
  assert.equal(SalaryStructureModel.rows.length, 1);
  assert.equal(structure.version, 1);
});

test('a configuration change on a versioned structure creates a new version and freezes the old one', async () => {
  const { service, SalaryStructureModel, companyId } = makeHarness();
  const created = await service.createStructure({ companyId, payload: basePayload(), actor });

  // Simulate history behind this structure (first version bump already happened).
  SalaryStructureModel.rows[0].version = 2;

  const { structure, versioned } = await service.updateStructure({
    companyId,
    structureId: created._id,
    payload: {
      items: [
        ...baseItems(),
        { componentCode: 'PT', calculationMethod: 'FIXED_AMOUNT', value: 200, order: 5 },
      ],
    },
    actor,
    req: { method: 'PATCH', originalUrl: '/api/payroll/structures/structure-1' },
  });

  assert.equal(versioned, true);
  assert.equal(structure.version, 3);
  assert.equal(structure.isCurrent, true);
  assert.equal(SalaryStructureModel.rows.length, 2);

  const previous = SalaryStructureModel.rows.find((row) => String(row._id) === String(created._id));
  assert.equal(previous.isCurrent, false);
  assert.ok(previous.effectiveTo instanceof Date);
  // The frozen version keeps its original configuration.
  assert.equal(previous.items.length, 5);
});

test('renaming only does not force a new version', async () => {
  const { service, SalaryStructureModel, companyId } = makeHarness();
  const created = await service.createStructure({ companyId, payload: basePayload(), actor });
  SalaryStructureModel.rows[0].version = 2;

  const { versioned } = await service.updateStructure({
    companyId,
    structureId: created._id,
    payload: { description: 'renamed description' },
    actor,
  });

  assert.equal(versioned, false);
  assert.equal(SalaryStructureModel.rows.length, 1);
});

// ── 11. status + clone through the service ─────────────────────────────────

test('setStatus applies the transition, audits it and rejects illegal ones', async () => {
  const { service, SalaryStructureModel, auditRows, companyId } = makeHarness();
  const created = await service.createStructure({ companyId, payload: basePayload(), actor });

  const activated = await service.setStatus({ companyId, structureId: created._id, status: 'ACTIVE', actor });
  assert.equal(activated.status, 'ACTIVE');
  assert.equal(SalaryStructureModel.rows[0].status, 'ACTIVE');
  assert.equal(auditRows.at(-1).action, 'SALARY_STRUCTURE_ACTIVE');

  await assert.rejects(
    () => service.setStatus({ companyId, structureId: created._id, status: 'DRAFT', actor }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    () => service.setStatus({ companyId, structureId: created._id, status: 'ACTIVE', actor }),
    (error) => error.statusCode === 400,
  );
});

test('cloneStructure copies the configuration into a fresh draft', async () => {
  const { service, SalaryStructureModel, auditRows, companyId } = makeHarness();
  const created = await service.createStructure({ companyId, payload: basePayload(), actor });
  await service.setStatus({ companyId, structureId: created._id, status: 'ACTIVE', actor });

  const clone = await service.cloneStructure({
    companyId,
    structureId: created._id,
    payload: { name: 'Contractor Structure', code: 'CNT-2026' },
    actor,
  });

  assert.equal(clone.status, 'DRAFT');
  assert.equal(clone.version, 1);
  assert.equal(clone.previousVersionId, null);
  assert.equal(clone.items.length, 5);
  assert.equal(SalaryStructureModel.rows.length, 2);
  assert.equal(auditRows.at(-1).action, 'SALARY_STRUCTURE_CLONED');
});

// ── 12. usage (§17) ────────────────────────────────────────────────────────

test('usage is reported honestly: employees stay 0 until Phase 29.4', async () => {
  const { service, companyId } = makeHarness();
  const created = await service.createStructure({ companyId, payload: basePayload(), actor });

  const usage = await service.getUsage({ companyId, structureId: created._id });

  assert.equal(usage.employees, 0);
  assert.equal(usage.departments, 0);
  assert.equal(usage.versions, 1);
  assert.equal(usage.hasProcessedPayroll, false);
  assert.equal(usage.hasHistoricalVersions, false);
});

test('component usage counts the structures that reference it (29.2 ↔ 29.3)', async () => {
  const { service, SalaryStructureModel, companyId } = makeHarness();
  await service.createStructure({ companyId, payload: basePayload(), actor });

  assert.equal(await service.countStructuresUsingComponent({ companyId, componentCode: 'BASIC' }), 1);
  assert.equal(await service.countStructuresUsingComponent({ companyId, componentCode: 'PT' }), 0);
  assert.equal(SalaryStructureModel.rows.length, 1);

  // The 29.2 service reports the same number through the injected counter.
  const componentService = makeSalaryComponentService({
    SalaryComponentModel: {
      findOne: (filter = {}) => ({
        select: () => ({
          lean: async () => ({ _id: filter._id, code: 'BASIC', companyId: filter.companyId, version: 1 }),
        }),
      }),
    },
    structureUsage: ({ companyId: id, componentCode }) =>
      service.countStructuresUsingComponent({ companyId: id, componentCode }),
  });

  const usage = await componentService.getUsage({ companyId, componentId: 'component-1' });
  assert.equal(usage.structures, 1);
});

// ── 13. RBAC wiring (§4 / §21) ─────────────────────────────────────────────

const CATALOGUE = DEFAULT_PERMISSIONS.map((permission) => permission.name || permission);

test('the structure permissions exist and are distributed by permission, not by role name', () => {
  for (const permission of [
    'SALARY_STRUCTURE_READ',
    'SALARY_STRUCTURE_MANAGE',
    'SALARY_STRUCTURE_ACTIVATE',
  ]) {
    assert.ok(CATALOGUE.includes(permission), `${permission} missing`);
    assert.ok(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(permission));
  }

  // HR Manager may build structures, activation is a separate duty (29.2 model).
  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('SALARY_STRUCTURE_READ'));
  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('SALARY_STRUCTURE_MANAGE'));
  assert.equal(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('SALARY_STRUCTURE_ACTIVATE'), false);

  // Manager / Team Lead / Employee hold nothing by default (grantable).
  for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    assert.equal(
      DEFAULT_ROLE_MATRIX[role].filter((permission) => permission.startsWith('SALARY_STRUCTURE')).length,
      0,
      `${role} must not hold structure permissions by default`,
    );
  }
});

test('the Payroll Admin template can build and activate structures', () => {
  const template = ROLE_TEMPLATES.find((entry) => entry.key === 'PAYROLL_ADMIN');
  assert.ok(template, 'PAYROLL_ADMIN template missing');
  for (const permission of [
    'SALARY_STRUCTURE_READ',
    'SALARY_STRUCTURE_MANAGE',
    'SALARY_STRUCTURE_ACTIVATE',
  ]) {
    assert.ok(template.permissions.includes(permission), `${permission} missing on PAYROLL_ADMIN`);
  }
});

test('every permission a template grants exists in the catalogue', () => {
  for (const template of ROLE_TEMPLATES) {
    for (const permission of template.permissions) {
      assert.ok(
        CATALOGUE.includes(permission),
        `${template.key} grants unknown permission ${permission}`,
      );
    }
  }
});

// ── 14. source conventions ─────────────────────────────────────────────────

const readSource = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('29.3 backend sources are ESM, tenant-scoped and free of hardcoded roles', async () => {
  const files = [
    'src/services/payroll/salaryStructureRules.js',
    'src/services/payroll/salaryStructureService.js',
    'src/controllers/salaryStructureController.js',
    'src/validators/salaryStructureValidator.js',
    'src/routes/salaryStructureRoutes.js',
    'src/models/SalaryStructureTemplate.js',
  ];

  for (const file of files) {
    const source = await readSource(file);

    assert.equal(/\bfunction\s+\w+\s*\(/.test(source), false, `${file} must stay arrow-function ESM`);
    assert.equal(/\brequire\s*\(/.test(source), false, `${file} must not use require()`);
    // The rules module is pure domain logic and the validator only checks
    // shape; tenant scoping lives in the service, model and routes.
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

test('structure routes authenticate, scope the tenant and check permissions', async () => {
  const source = await readSource('src/routes/salaryStructureRoutes.js');

  assert.match(source, /protect/);
  assert.match(source, /tenantContext/);
  assert.match(source, /requirePermission\('SALARY_STRUCTURE_READ'\)/);
  assert.match(source, /requirePermission\('SALARY_STRUCTURE_MANAGE'\)/);
  assert.match(source, /requirePermission\('SALARY_STRUCTURE_ACTIVATE'\)/);
  assert.match(source, /checkWriteAccess/);
  assert.match(source, /requireFeature\('payroll'\)/);
  assert.equal(/companyId:\s*req\.body/.test(source), false);
});

test('structure model indexes are companyId-first and the code is tenant-unique', async () => {
  const source = await readSource('src/models/SalaryStructureTemplate.js');
  assert.match(source, /companyId:\s*\{\s*type:\s*Schema\.Types\.ObjectId/);
  assert.match(source, /\{\s*companyId:\s*1,\s*code:\s*1\s*\}/);
  assert.match(source, /unique:\s*true/);
  assert.match(source, /\{\s*companyId:\s*1,\s*isCurrent:\s*1,\s*version:\s*-1\s*\}/);
});

// The legacy per-employee salary model (PayrollPage / payrollController) must
// survive Phase 29.3 untouched — "do not break existing functionality".
test('the legacy per-employee SalaryStructure model is untouched', async () => {
  const legacy = await readSource('src/models/SalaryStructure.js');
  const template = await readSource('src/models/SalaryStructureTemplate.js');

  assert.match(legacy, /user:\s*\{\s*type:\s*Schema\.Types\.ObjectId/);
  assert.match(legacy, /basic:/);
  assert.match(legacy, /pfPercent:/);
  assert.equal(/version:|isCurrent:/.test(legacy), false);

  // The 29.3 model is a separate collection, not a rewrite of the legacy one.
  assert.match(template, /mongoose\.model\('SalaryStructureTemplate'/);
  assert.match(template, /salaryStructureTemplateSchema/);
});

test('29.3 does not collide with the legacy /api/payroll/structures route', async () => {
  const index = await readSource('src/routes/index.js');
  const structureRoutes = await readSource('src/routes/salaryStructureRoutes.js');

  assert.match(index, /router\.use\("\/payroll\/salary-structures", salaryStructureRoutes\)/);
  assert.equal(
    /router\.use\("\/payroll\/structures"/.test(index),
    false,
    'the legacy PayrollPage endpoint must stay reserved',
  );
  // No route handler mounts itself at the legacy path.
  assert.equal(/router\.use\('\/'/.test(structureRoutes), false);

  const frontend = await readFile(
    new URL('../../Frontend/src/services/salaryStructureService.js', import.meta.url),
    'utf8',
  );
  assert.match(frontend, /'\/payroll\/salary-structures'/);
  assert.equal(/'\/payroll\/structures'/.test(frontend), false);
});

test('the preview endpoint never persists anything', async () => {
  const source = await readSource('src/services/payroll/salaryStructureService.js');
  const previewBlock = source.slice(source.indexOf('const previewStructure'));
  assert.equal(/\.create\(|\.save\(|updateOne|updateMany/.test(previewBlock.slice(0, 600)), false);
});
