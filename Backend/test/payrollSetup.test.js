import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import mongoose from 'mongoose';

// Hermetic suite: no MongoDB, no Redis, no network.
// (MongoDB is never contacted because every model access goes through an
//  injected fake; Redis is disabled so the cache abstraction fails open.)
process.env.REDIS_ENABLED ||= 'false';
process.env.FIELD_ENCRYPTION_KEY ||= 'payroll-setup-test-key';

const [rules, service, { getOrSetCache }, { DEFAULT_ROLE_MATRIX, DEFAULT_PERMISSIONS }, { encryptSensitiveValue }] =
  await Promise.all([
    import('../src/services/payroll/payrollSetupRules.js'),
    import('../src/services/payroll/payrollSetupService.js'),
    import('../src/services/redisCacheService.js'),
    import('../src/utils/permissionRegistry.js'),
    import('../src/utils/fieldEncryption.js'),
  ]);

const {
  ACTIVATABLE_STATUSES,
  canActivate,
  canTransition,
  defaultPayrollSetupConfiguration,
  evaluateConfiguration,
  isValidAccountNumber,
  isValidCin,
  isValidGst,
  isValidIfsc,
  isValidPan,
  isValidReferencePrefix,
  isValidTan,
  maskAccountNumber,
  validateBankSection,
  validateLegalSection,
  validatePolicySection,
  validateStatutorySection,
  weekendPolicySummary,
  weekendPolicyToWorkingDays,
} = rules;

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// ── A configuration that satisfies every rule (§20 review state) ───────────
const completeConfig = () => ({
  legal: {
    legalName: 'Acme Technologies Pvt Ltd',
    pan: 'ABCDE1234F',
    tan: 'BLRA12345C',
    gst: '27ABCDE1234F1Z5',
    cin: 'U72200KA2010PTC055123',
    addressLine: '42 Residency Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    country: 'India',
  },
  statutory: {
    pf: { applicable: true, establishmentNumber: 'KABOM1234567', registrationDate: null },
    esi: { applicable: true, registrationNumber: '1234567890123456' },
    professionalTax: { applicable: true, state: 'Karnataka' },
    labourWelfareFund: { applicable: false, state: '' },
    gratuity: { applicable: true },
    tds: { applicable: true },
  },
  payrollPolicy: {
    frequency: 'MONTHLY',
    cycleType: 'FIXED_MONTH_DAY',
    cycleStartDay: 1,
    cycleEndDay: 31,
    paymentDateType: 'SPECIFIC_DAY',
    paymentDayOfMonth: 30,
    paymentMonthOffset: 0,
    currency: 'INR',
    financialYearStartMonth: 4,
    weekendPolicy: { type: 'SAT_SUN', customWorkingDays: [] },
    lopPolicy: { basis: 'PER_DAY' },
    overtimePolicy: { enabled: false, basis: 'HOURLY', multiplier: 1 },
    processingDeadlineDay: 25,
    lockRequiresReopen: true,
  },
  bankAccount: {
    bankName: 'HDFC Bank',
    accountHolderName: 'Acme Technologies Pvt Ltd',
    ifsc: 'HDFC0001234',
    branch: 'Koramangala',
    accountType: 'CURRENT',
    paymentReferencePrefix: 'CREWLYSAL',
    accountNumber: '12345678901234',
    accountNumberLast4: '1234',
  },
});

// ── Fake model: records every query so tenant scoping is provable ──────────

const toPlain = (value) => JSON.parse(JSON.stringify(value));

const createFakeModel = (initialDoc) => {
  const state = { doc: initialDoc, calls: [] };

  const matches = (query = {}, doc) => {
    if (!doc) return false;
    return Object.entries(query).every(([key, value]) => {
      if (value && typeof value === 'object' && Array.isArray(value.$in)) {
        return value.$in.includes(doc[key]);
      }
      return String(doc[key]) === String(value);
    });
  };

  const setPath = (target, path, value) => {
    const parts = String(path).split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor[parts[i]] = cursor[parts[i]] || {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  };

  const thenable = (value) => ({
    lean: async () => (value ? toPlain(value) : null),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  });

  return {
    state,
    calls: state.calls,
    findOne(query = {}) {
      state.calls.push({ op: 'findOne', query: toPlain(query) });
      return thenable(matches(query, state.doc) ? state.doc : null);
    },
    findOneAndUpdate(filter = {}, update = {}, options = {}) {
      state.calls.push({ op: 'findOneAndUpdate', filter: toPlain(filter), update: toPlain(update), options });
      if (!state.doc && options.upsert) {
        state.doc = { _id: new mongoose.Types.ObjectId().toString(), ...toPlain(update.$setOnInsert || {}) };
      }
      if (!matches(filter, state.doc)) return thenable(null);
      for (const [path, value] of Object.entries(update.$set || {})) setPath(state.doc, path, value);
      for (const [path, value] of Object.entries(update.$setOnInsert || {})) {
        if (!(path in state.doc)) setPath(state.doc, path, value);
      }
      for (const [path, amount] of Object.entries(update.$inc || {})) {
        state.doc[path] = Number(state.doc[path] || 0) + Number(amount);
      }
      for (const [path, value] of Object.entries(update.$addToSet || {})) {
        // Mirrors Mongo's $addToSet on a dotted path (setup.savedSections).
        const parts = String(path).split('.');
        let cursor = state.doc;
        for (let i = 0; i < parts.length - 1; i += 1) {
          cursor[parts[i]] = cursor[parts[i]] || {};
          cursor = cursor[parts[i]];
        }
        const key = parts[parts.length - 1];
        if (!Array.isArray(cursor[key])) cursor[key] = [];
        if (!cursor[key].includes(value)) cursor[key].push(value);
      }
      return thenable(toPlain(state.doc));
    },
  };
};

const createSetupDoc = ({
  companyId = COMPANY_A,
  status = 'DRAFT',
  configVersion = 1,
  config,
  savedSections = [],
} = {}) => ({
  _id: new mongoose.Types.ObjectId().toString(),
  companyId,
  status,
  configVersion,
  legal: { ...defaultPayrollSetupConfiguration().legal, ...(config?.legal || {}) },
  statutory: { ...defaultPayrollSetupConfiguration().statutory, ...(config?.statutory || {}) },
  payrollPolicy: { ...defaultPayrollSetupConfiguration().payrollPolicy, ...(config?.payrollPolicy || {}) },
  bankAccount: { ...defaultPayrollSetupConfiguration().bankAccount, ...(config?.bankAccount || {}) },
  setup: { currentStep: 1, completedSections: [], savedSections, lastSavedAt: null },
  activation: {
    activatedAt: null,
    activatedBy: null,
    suspendedAt: null,
    suspendedBy: null,
    suspendReason: '',
  },
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: null,
  isCurrent: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

const noAudit = async () => null;
const noNotify = async () => null;

// ═══════════════════════════════════════════════════════════════════════════
// §7 — Legal identifier validation
// ═══════════════════════════════════════════════════════════════════════════

test('PAN / TAN / GST / CIN / IFSC format validation', () => {
  assert.equal(isValidPan('ABCDE1234F'), true);
  assert.equal(isValidPan('abcde1234f'), true, 'lowercase input is normalised');
  assert.equal(isValidPan('ABCD12345F'), false);
  assert.equal(isValidPan(''), false);

  assert.equal(isValidTan('BLRA12345C'), true);
  assert.equal(isValidTan('BLRA1234C'), false);

  assert.equal(isValidGst('27ABCDE1234F1Z5'), true);
  assert.equal(isValidGst('27ABCDE1234F1Z'), false);

  assert.equal(isValidCin('U72200KA2010PTC055123'), true);
  assert.equal(isValidCin('X72200KA2010PTC055123'), false);

  assert.equal(isValidIfsc('HDFC0001234'), true);
  assert.equal(isValidIfsc('HDFC1231234'), false, 'IFSC position 5 must be zero');
  assert.equal(isValidIfsc('HDFC1234'), false);

  assert.equal(isValidAccountNumber('12345678901234'), true);
  assert.equal(isValidAccountNumber('1234567'), false, 'fewer than 8 digits is rejected');

  assert.equal(isValidReferencePrefix('CREWLYSAL'), true);
  assert.equal(isValidReferencePrefix('A'), false);
});

test('legal section validation: required fields and optional formats', () => {
  const incomplete = validateLegalSection({ legalName: '', state: '', country: '' });
  assert.equal(incomplete.length, 3);

  const badPan = validateLegalSection({
    legalName: 'Acme',
    state: 'Karnataka',
    country: 'India',
    pan: 'NOPE',
  });
  assert.equal(badPan.length, 1);
  assert.equal(badPan[0].field, 'legal.pan');

  const good = validateLegalSection({
    legalName: 'Acme',
    state: 'Karnataka',
    country: 'India',
    pan: 'ABCDE1234F',
    gst: '27ABCDE1234F1Z5',
  });
  assert.deepEqual(good, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 / §9 — Conditional statutory requirements
// ═══════════════════════════════════════════════════════════════════════════

test('statutory fields are optional until the component is switched on', () => {
  const allOff = validateStatutorySection({
    pf: { applicable: false },
    esi: { applicable: false },
    professionalTax: { applicable: false },
    labourWelfareFund: { applicable: false },
    gratuity: { applicable: false },
    tds: { applicable: false },
  });
  assert.deepEqual(allOff, [], 'PF disabled → no PF registration required');
});

test('enabling a statutory component makes its registration mandatory', () => {
  const errors = validateStatutorySection({
    pf: { applicable: true, establishmentNumber: '' },
    esi: { applicable: true, registrationNumber: '' },
    professionalTax: { applicable: true, state: '' },
    labourWelfareFund: { applicable: true, state: '' },
    gratuity: { applicable: true },
    tds: { applicable: true },
  });
  const fields = errors.map((e) => e.field);
  assert.ok(fields.includes('statutory.pf.establishmentNumber'));
  assert.ok(fields.includes('statutory.esi.registrationNumber'));
  assert.ok(fields.includes('statutory.professionalTax.state'));
  assert.ok(fields.includes('statutory.labourWelfareFund.state'));
  assert.ok(fields.includes('legal.pan'), 'TDS requires the company PAN (cross-section rule)');

  const satisfied = validateStatutorySection(
    {
      pf: { applicable: true, establishmentNumber: 'KABOM1234567' },
      esi: { applicable: true, registrationNumber: '1234567890123456' },
      professionalTax: { applicable: true, state: 'Karnataka' },
      labourWelfareFund: { applicable: false, state: '' },
      gratuity: { applicable: true },
      tds: { applicable: true },
    },
    { pan: 'ABCDE1234F' },
  );
  assert.deepEqual(satisfied, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// §11–§15 — Payroll policy validation
// ═══════════════════════════════════════════════════════════════════════════

test('payroll cycle is never hard-coded to 1–31', () => {
  const custom = { ...completeConfig().payrollPolicy, cycleStartDay: 26, cycleEndDay: 25 };
  assert.deepEqual(validatePolicySection(custom), [], '26→25 cycle is valid');

  const broken = { ...custom, cycleStartDay: 32 };
  assert.ok(validatePolicySection(broken).some((e) => e.field === 'payrollPolicy.cycleStartDay'));

  const sameDay = { ...custom, cycleStartDay: 1, cycleEndDay: 1 };
  assert.ok(validatePolicySection(sameDay).some((e) => e.field === 'payrollPolicy.cycleEndDay'));
});

test('payment date, financial year, weekend, LOP and overtime rules', () => {
  const base = completeConfig().payrollPolicy;

  assert.ok(
    validatePolicySection({ ...base, paymentDateType: 'SPECIFIC_DAY', paymentDayOfMonth: 0 }).some(
      (e) => e.field === 'payrollPolicy.paymentDayOfMonth',
    ),
  );
  assert.deepEqual(
    validatePolicySection({ ...base, paymentDateType: 'LAST_WORKING_DAY', paymentDayOfMonth: 0 }),
    [],
    'last working day needs no day number',
  );
  assert.ok(
    validatePolicySection({ ...base, paymentMonthOffset: 3 }).some(
      (e) => e.field === 'payrollPolicy.paymentMonthOffset',
    ),
  );
  assert.ok(
    validatePolicySection({ ...base, financialYearStartMonth: 13 }).some(
      (e) => e.field === 'payrollPolicy.financialYearStartMonth',
    ),
  );
  assert.ok(
    validatePolicySection({ ...base, weekendPolicy: { type: 'CUSTOM', customWorkingDays: [] } }).some(
      (e) => e.field === 'payrollPolicy.weekendPolicy.customWorkingDays',
    ),
  );
  assert.deepEqual(
    validatePolicySection({
      ...base,
      weekendPolicy: { type: 'CUSTOM', customWorkingDays: ['MON', 'WED', 'FRI'] },
    }),
    [],
  );
  assert.ok(
    validatePolicySection({
      ...base,
      overtimePolicy: { enabled: true, basis: 'HOURLY', multiplier: 9 },
    }).some((e) => e.field === 'payrollPolicy.overtimePolicy.multiplier'),
  );
  assert.ok(
    validatePolicySection({ ...base, frequency: 'WEEKLY' }).some(
      (e) => e.field === 'payrollPolicy.frequency',
    ),
    'non-monthly frequency cannot be activated in this phase',
  );
});

test('weekend policy integrates with the existing attendance/shift vocabulary', () => {
  assert.deepEqual(weekendPolicyToWorkingDays({ type: 'SAT_SUN' }), ['MON', 'TUE', 'WED', 'THU', 'FRI']);
  assert.deepEqual(weekendPolicyToWorkingDays({ type: 'SUN_ONLY' }), ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
  assert.deepEqual(weekendPolicyToWorkingDays({ type: 'CUSTOM', customWorkingDays: ['MON', 'WED'] }), [
    'MON',
    'WED',
  ]);
  assert.equal(weekendPolicySummary({ type: 'SAT_SUN' }).label, 'MON–FRI working (SAT+SUN off)');
});

// ═══════════════════════════════════════════════════════════════════════════
// §16 — Bank validation
// ═══════════════════════════════════════════════════════════════════════════

test('bank section validation rejects invalid IFSC and account numbers', () => {
  const errors = validateBankSection({
    bankName: 'HDFC Bank',
    accountHolderName: 'Acme',
    accountNumber: '1234567',
    ifsc: 'HDFC1231234',
  });
  const fields = errors.map((e) => e.field);
  assert.ok(fields.includes('bankAccount.accountNumber'));
  assert.ok(fields.includes('bankAccount.ifsc'));

  assert.deepEqual(
    validateBankSection({
      bankName: 'HDFC Bank',
      accountHolderName: 'Acme',
      accountNumber: '12345678901234',
      ifsc: 'HDFC0001234',
      accountType: 'CURRENT',
    }),
    [],
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 / §21 — Section progress and the activation gate
// ═══════════════════════════════════════════════════════════════════════════

test('section progress counts and activation gate', () => {
  const empty = evaluateConfiguration(defaultPayrollSetupConfiguration(), { savedSections: [] });
  assert.equal(empty.completedCount, 0);
  assert.equal(empty.totalCount, 4);
  assert.equal(canActivate(empty), false);
  assert.equal(empty.sections.filter((s) => s.complete).length, 0);

  const complete = evaluateConfiguration(completeConfig(), {
    savedSections: ['LEGAL', 'STATUTORY', 'POLICY', 'BANK'],
  });
  assert.equal(complete.completedCount, 4);
  assert.equal(canActivate(complete), true);
  assert.equal(complete.warnings.length, 0);
});

test('review warnings surface questionable configuration', () => {
  const config = completeConfig();
  config.statutory.pf.applicable = false;
  config.statutory.esi.applicable = false;
  config.bankAccount.paymentReferencePrefix = '';
  const evaluation = evaluateConfiguration(config, {
    savedSections: ['LEGAL', 'STATUTORY', 'POLICY', 'BANK'],
  });
  const codes = evaluation.warnings.map((w) => w.code);
  assert.ok(codes.includes('NO_STATUTORY_COMPONENTS'));
  assert.ok(codes.includes('NO_PAYMENT_REFERENCE'));
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 — Status machine
// ═══════════════════════════════════════════════════════════════════════════

test('setup status transitions follow the documented flow', () => {
  assert.equal(canTransition('NOT_CONFIGURED', 'DRAFT'), true);
  assert.equal(canTransition('NOT_CONFIGURED', 'ACTIVE'), false);
  assert.equal(canTransition('DRAFT', 'CONFIGURED'), true);
  assert.equal(canTransition('DRAFT', 'SUSPENDED'), false, 'a draft is never suspended');
  assert.equal(canTransition('CONFIGURED', 'ACTIVE'), true);
  assert.equal(canTransition('ACTIVE', 'SUSPENDED'), true);
  assert.equal(canTransition('ACTIVE', 'DRAFT'), false, 'an active setup is never silently downgraded');
  assert.deepEqual([...ACTIVATABLE_STATUSES], ['DRAFT', 'CONFIGURED', 'SUSPENDED']);
});

// ═══════════════════════════════════════════════════════════════════════════
// §17 — Bank masking
// ═══════════════════════════════════════════════════════════════════════════

test('account numbers are masked and never reversible from the mask', () => {
  const masked = maskAccountNumber('12345678901234');
  assert.equal(masked, 'XXXX XXXX 1234');
  assert.ok(masked.endsWith('1234'));
  assert.ok(!masked.includes('567890'), 'the middle of the account number is never shown');
  assert.equal(maskAccountNumber(''), '');
});

test('serialized configuration never contains the full account number', () => {
  const doc = createSetupDoc({
    config: {
      bankAccount: {
        bankName: 'HDFC Bank',
        accountNumber: encryptSensitiveValue('12345678901234'),
        accountNumberLast4: '1234',
        accountNumberMasked: 'XXXX XXXX 1234',
      },
    },
  });
  const serialized = service.serializePayrollSetup(doc);
  const dump = JSON.stringify(serialized);
  assert.equal(dump.includes('12345678901234'), false, 'full account number must never leave the service');
  assert.ok(!('accountNumber' in serialized.bankAccount));
  assert.equal(serialized.bankAccount.maskedAccountNumber, 'XXXX XXXX 1234');
  assert.equal(serialized.bankAccount.accountNumberLast4, '1234');
  assert.equal(serialized.bankAccount.hasAccountNumber, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 — Tenant isolation (provable from the recorded queries)
// ═══════════════════════════════════════════════════════════════════════════

test('every payroll setup query is scoped by companyId and isCurrent', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A }));
  await service.getPayrollSetup({ companyId: COMPANY_A, PayrollSetupModel: model });

  const calls = model.calls.filter((c) => c.op === 'findOne');
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(String(call.query.companyId), COMPANY_A, 'companyId always comes from the tenant context');
    assert.equal(call.query.isCurrent, true);
  }
});

test('company B can never read company A configuration', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A }));
  const result = await service.getPayrollSetup({ companyId: COMPANY_B, PayrollSetupModel: model });

  // The fake only matches the queried companyId — company A's document is
  // invisible to company B, so the response is the NOT_CONFIGURED default
  // rather than another tenant's data.
  assert.equal(result.config.status, 'NOT_CONFIGURED');
  assert.equal(result.config.companyId, COMPANY_B);
  assert.equal(result.config.legal.legalName, '');
});

test('a request without a tenant context is rejected', async () => {
  await assert.rejects(
    () => service.getPayrollSetup({ companyId: null }),
    /Company context is required/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// §25 / §26 — Redis cache behaviour (injected, fail-open)
// ═══════════════════════════════════════════════════════════════════════════

test('cache key follows the existing tenant cache convention', () => {
  const key = service.buildSetupCacheKey(COMPANY_A);
  assert.equal(key, `crewly:cache:company:${COMPANY_A}:payroll-setup:v1:current`);
  assert.equal(service.buildSetupCacheKey('not-an-object-id'), null, 'unsafe companyId bypasses the cache');
});

test('cache TTL is clamped to a sane range', () => {
  assert.equal(service.getSetupCacheTtlSeconds({ PAYROLL_SETUP_CACHE_TTL_SECONDS: '1' }), 10);
  assert.equal(service.getSetupCacheTtlSeconds({ PAYROLL_SETUP_CACHE_TTL_SECONDS: '99999' }), 3600);
  assert.equal(service.getSetupCacheTtlSeconds({}), 300);
});

const createIo = () => {
  const store = new Map();
  return {
    store,
    delCalls: [],
    get: async (key) => {
      if (!store.has(key)) return null;
      try {
        return JSON.parse(store.get(key));
      } catch {
        return null; // mirrors redisCacheService: corrupt entry = miss
      }
    },
    set: async (key, value) => {
      store.set(key, JSON.stringify(value));
      return true;
    },
    del: async (key) => {
      this;
      return store.delete(key);
    },
  };
};

test('configuration is cached, then served from cache, then invalidated', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A, status: 'ACTIVE' }));
  const io = createIo();

  const first = await service.getPayrollSetup({ companyId: COMPANY_A, io, PayrollSetupModel: model });
  assert.equal(first.cache, 'MISS');
  assert.equal(first.config.status, 'ACTIVE');

  const second = await service.getPayrollSetup({ companyId: COMPANY_A, io, PayrollSetupModel: model });
  assert.equal(second.cache, 'HIT');
  assert.equal(second.config.status, 'ACTIVE');

  const key = service.buildSetupCacheKey(COMPANY_A);
  await io.del(key); // the same exact-key delete the service performs
  const third = await service.getPayrollSetup({ companyId: COMPANY_A, io, PayrollSetupModel: model });
  assert.equal(third.cache, 'MISS');
});

test('MongoDB remains the source of truth when Redis is unavailable', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A, status: 'CONFIGURED' }));
  const result = await service.getPayrollSetup({ companyId: COMPANY_A, PayrollSetupModel: model });
  assert.equal(result.config.status, 'CONFIGURED', 'Mongo read still works with Redis disabled');

  // Invalidation is fail-open: returns false, never throws.
  await assert.doesNotReject(() => service.invalidatePayrollSetupCache(COMPANY_A));
  assert.equal(await service.invalidatePayrollSetupCache(COMPANY_A), false);
});

test('a corrupt cache entry falls through to MongoDB', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A, status: 'DRAFT' }));
  const io = createIo();
  io.store.set(service.buildSetupCacheKey(COMPANY_A), 'not-json');

  const result = await getOrSetCache(service.buildSetupCacheKey(COMPANY_A), {
    ttlSeconds: 30,
    version: 1,
    loader: async () => ({ status: 'FROM_MONGO' }),
    io,
  });
  assert.deepEqual(result.value, { status: 'FROM_MONGO' });
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 / §32 — Draft autosave
// ═══════════════════════════════════════════════════════════════════════════

test('partial sections can be saved (wizard autosave) with format errors rejected', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A }));

  const saved = await service.updatePayrollSetupSection({
    companyId: COMPANY_A,
    section: 'LEGAL',
    payload: { legalName: 'Half Finished' },
    actor: { id: 'user-1', name: 'Admin', role: 'COMPANY_ADMIN' },
    audit: noAudit,
    PayrollSetupModel: model,
  });
  assert.equal(saved.config.status, 'DRAFT', 'incomplete setup stays DRAFT');
  assert.equal(saved.config.legal.legalName, 'Half Finished');
  assert.deepEqual(model.state.doc.setup.savedSections, ['LEGAL']);
  assert.equal(model.state.doc.configVersion, 2, 'configVersion is bumped on every save');

  await assert.rejects(
    () =>
      service.updatePayrollSetupSection({
        companyId: COMPANY_A,
        section: 'LEGAL',
        payload: { pan: 'NOT-A-PAN' },
        audit: noAudit,
        PayrollSetupModel: model,
      }),
    (error) => error.statusCode === 400 && error.errors?.some((e) => e.field === 'legal.pan'),
  );
});

test('completing every section moves DRAFT → CONFIGURED', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A }));
  const actor = { id: 'user-1', name: 'Admin', role: 'COMPANY_ADMIN' };
  const config = completeConfig();

  await service.updatePayrollSetupSection({
    companyId: COMPANY_A,
    section: 'LEGAL',
    payload: config.legal,
    actor,
    audit: noAudit,
    PayrollSetupModel: model,
  });
  await service.updatePayrollSetupSection({
    companyId: COMPANY_A,
    section: 'STATUTORY',
    payload: config.statutory,
    actor,
    audit: noAudit,
    PayrollSetupModel: model,
  });
  await service.updatePayrollSetupSection({
    companyId: COMPANY_A,
    section: 'POLICY',
    payload: config.payrollPolicy,
    actor,
    audit: noAudit,
    PayrollSetupModel: model,
  });
  const final = await service.updatePayrollSetupSection({
    companyId: COMPANY_A,
    section: 'BANK',
    payload: config.bankAccount,
    actor,
    audit: noAudit,
    PayrollSetupModel: model,
  });

  assert.equal(final.config.status, 'CONFIGURED');
  assert.equal(final.evaluation.allComplete, true);
  assert.deepEqual(final.config.setup.completedSections, ['LEGAL', 'STATUTORY', 'POLICY', 'BANK']);
  // The account number is stored encrypted and only the mask is returned.
  assert.equal(final.config.bankAccount.maskedAccountNumber, 'XXXX XXXX 1234');
  assert.ok(model.state.doc.bankAccount.accountNumber.startsWith('v1.'));
});

test('concurrent updates are rejected with 409 (optimistic concurrency)', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A, configVersion: 4 }));
  await assert.rejects(
    () =>
      service.updatePayrollSetupSection({
        companyId: COMPANY_A,
        section: 'LEGAL',
        payload: { legalName: 'Stale Write' },
        expectedVersion: 2,
        audit: noAudit,
        PayrollSetupModel: model,
      }),
    (error) => error.statusCode === 409,
  );
  assert.equal(model.state.doc.legal.legalName, '', 'the stale write never lands');
});

test('an unknown section is rejected', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A }));
  await assert.rejects(
    () =>
      service.updatePayrollSetupSection({
        companyId: COMPANY_A,
        section: 'SALARY',
        payload: {},
        audit: noAudit,
        PayrollSetupModel: model,
      }),
    /Unknown payroll setup section/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// §21 / §24 — Activation, audit and notification
// ═══════════════════════════════════════════════════════════════════════════

test('incomplete setup cannot be activated', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A }));
  await assert.rejects(
    () =>
      service.activatePayrollSetup({
        companyId: COMPANY_A,
        actor: { id: 'user-1' },
        audit: noAudit,
        notifier: noNotify,
        PayrollSetupModel: model,
        CompanyModel: { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Acme' }) }) }) },
      }),
    (error) => error.statusCode === 400 && /incomplete/i.test(error.message),
  );
  assert.equal(model.state.doc.status, 'DRAFT');
});

test('complete setup activates, audits and notifies', async () => {
  const model = createFakeModel(
    createSetupDoc({
      companyId: COMPANY_A,
      status: 'CONFIGURED',
      config: completeConfig(),
      savedSections: ['LEGAL', 'STATUTORY', 'POLICY', 'BANK'],
    }),
  );
  const audits = [];
  let notified = null;

  const result = await service.activatePayrollSetup({
    companyId: COMPANY_A,
    actor: { id: 'user-1', name: 'Admin', role: 'COMPANY_ADMIN' },
    audit: async (entry) => {
      audits.push(entry);
      return null;
    },
    notifier: async (args) => {
      notified = args;
    },
    PayrollSetupModel: model,
    CompanyModel: { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Acme Technologies' }) }) }) },
  });

  assert.equal(result.config.status, 'ACTIVE');
  assert.ok(result.config.activation.activatedAt);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'Payroll activated');
  assert.equal(audits[0].companyId, COMPANY_A);
  assert.equal(audits[0].newValue.status, 'ACTIVE');
  assert.ok(notified, 'admins are notified through the existing notification service');
  assert.equal(notified.companyName, 'Acme Technologies');

  const guarded = model.calls.filter((c) => c.op === 'findOneAndUpdate').pop();
  assert.equal(String(guarded.filter.companyId), COMPANY_A);
  assert.deepEqual(guarded.filter.status.$in, ['DRAFT', 'CONFIGURED', 'SUSPENDED']);
});

test('activation is blocked for a company that never started setup', async () => {
  const model = createFakeModel(null);
  await assert.rejects(
    () =>
      service.activatePayrollSetup({
        companyId: COMPANY_A,
        audit: noAudit,
        notifier: noNotify,
        PayrollSetupModel: model,
      }),
    (error) => error.statusCode === 404,
  );
});

test('suspend is only allowed from ACTIVE and is audited', async () => {
  const activeModel = createFakeModel(
    createSetupDoc({
      companyId: COMPANY_A,
      status: 'ACTIVE',
      config: completeConfig(),
      savedSections: ['LEGAL', 'STATUTORY', 'POLICY', 'BANK'],
    }),
  );
  const audits = [];
  const suspended = await service.suspendPayrollSetup({
    companyId: COMPANY_A,
    reason: 'Statutory review',
    actor: { id: 'user-1' },
    audit: async (entry) => {
      audits.push(entry);
      return null;
    },
    PayrollSetupModel: activeModel,
  });
  assert.equal(suspended.config.status, 'SUSPENDED');
  assert.equal(audits[0].action, 'Payroll suspended');

  const draftModel = createFakeModel(createSetupDoc({ companyId: COMPANY_A, status: 'DRAFT' }));
  await assert.rejects(
    () =>
      service.suspendPayrollSetup({
        companyId: COMPANY_A,
        audit: noAudit,
        PayrollSetupModel: draftModel,
      }),
    (error) => error.statusCode === 409,
  );
});

test('bank details are masked in audit records', async () => {
  const model = createFakeModel(createSetupDoc({ companyId: COMPANY_A }));
  const audits = [];
  await service.updatePayrollSetupSection({
    companyId: COMPANY_A,
    section: 'BANK',
    payload: {
      bankName: 'HDFC Bank',
      accountHolderName: 'Acme',
      accountNumber: '12345678901234',
      ifsc: 'HDFC0001234',
    },
    actor: { id: 'user-1' },
    audit: async (entry) => {
      audits.push(entry);
      return null;
    },
    PayrollSetupModel: model,
  });

  const auditDump = JSON.stringify(audits);
  assert.equal(auditDump.includes('12345678901234'), false, 'account number is never written to the audit log');
  assert.equal(audits[0].newValue.accountNumber, '[MASKED]');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 — RBAC wiring
// ═══════════════════════════════════════════════════════════════════════════

test('payroll setup permissions exist and are assigned by least privilege', () => {
  const names = DEFAULT_PERMISSIONS.map((p) => p.name);
  for (const permission of ['PAYROLL_SETUP_READ', 'PAYROLL_SETUP_UPDATE', 'PAYROLL_SETUP_ACTIVATE']) {
    assert.ok(names.includes(permission), `${permission} must exist in the registry`);
  }

  for (const permission of ['PAYROLL_SETUP_READ', 'PAYROLL_SETUP_UPDATE', 'PAYROLL_SETUP_ACTIVATE']) {
    assert.ok(
      DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(permission),
      `Company Admin must hold ${permission}`,
    );
  }

  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('PAYROLL_SETUP_READ'));
  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('PAYROLL_SETUP_UPDATE'));
  assert.equal(
    DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('PAYROLL_SETUP_ACTIVATE'),
    false,
    'activation stays with Company Admin',
  );

  for (const role of ['EMPLOYEE', 'MANAGER', 'TEAM_LEAD']) {
    for (const permission of ['PAYROLL_SETUP_READ', 'PAYROLL_SETUP_UPDATE', 'PAYROLL_SETUP_ACTIVATE']) {
      assert.equal(
        DEFAULT_ROLE_MATRIX[role].includes(permission),
        false,
        `${role} must never hold ${permission}`,
      );
    }
  }
});

test('the permission migration version is at least the Phase 29.1 baseline', async () => {
  const source = await readFile(new URL('../src/utils/permissionService.js', import.meta.url), 'utf8');
  const version = Number(source.match(/SYSTEM_PERMISSION_VERSION\s*=\s*(\d+)/)?.[1]);
  // 14 = Phase 29.1 payroll setup permissions,
  // 15 = Phase 29.1 RBAC update (granular payroll catalogue).
  assert.ok(version >= 14, `expected migration version >= 14, got ${version}`);
});

test('payroll setup is gated behind the payroll subscription feature', async () => {
  const source = await readFile(new URL('../src/utils/permissionService.js', import.meta.url), 'utf8');
  assert.match(source, /PAYROLL_SETUP:\s*"payroll"/);
});
