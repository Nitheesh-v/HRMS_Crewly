// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.2 — SALARY COMPONENT SERVICE (tenant-safe persistence)
//
//  Order of operations for every write (§57):
//      validate → authorize (route) → tenant → dependencies → save
//      → invalidate cache → audit
//
//  REDIS (§39 / §40): reuses the Phase 28 redisCacheService. MongoDB stays
//  the source of truth: if Redis is down the service still reads and
//  writes — only the cache layer is skipped, never the data (§40).
//
//  BULLMQ (§41): component CRUD stays synchronous. No queue is introduced;
//  the existing audit + notification infrastructure is used directly, which
//  is the pattern Phase 29.1 already follows.
//
//  Dependency injection: `makeSalaryComponentService` takes the models,
//  cache and audit writer, which is what makes the hermetic test suite
//  possible (no MongoDB, no Redis, no network).
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import {
  COMPONENT_STATUS,
  describeCalculation,
  detectCircularDependency,
  filterComponents,
  normalizeSalaryComponent,
  suggestDefaultComponents,
  upperCodeOrEmpty,
  validateSalaryComponent,
} from './salaryComponentRules.js';

export const CACHE_NAMESPACE = 'payroll-components';
export const CACHE_VERSION = 1;

const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const getComponentCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.SALARY_COMPONENT_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

// The fields a change to which must never rewrite payroll history (§58).
const CALCULATION_FIELDS = [
  'category',
  'calculationType',
  'defaultAmount',
  'percentage',
  'calculationBase',
  'dependsOnCode',
  'formula',
  'taxability',
  'pfApplicable',
  'esiApplicable',
  'tdsApplicable',
  'professionalTaxApplicable',
];

const snapshot = (component = {}) => ({
  name: component.name || '',
  code: component.code || '',
  category: component.category || '',
  calculationType: component.calculationType || '',
  defaultAmount: component.defaultAmount ?? null,
  percentage: component.percentage ?? null,
  calculationBase: component.calculationBase || null,
  dependsOnCode: component.dependsOnCode || '',
  taxability: component.taxability || '',
  pfApplicable: Boolean(component.pfApplicable),
  esiApplicable: Boolean(component.esiApplicable),
  tdsApplicable: Boolean(component.tdsApplicable),
  professionalTaxApplicable: Boolean(component.professionalTaxApplicable),
  status: component.status || '',
  version: component.version || 1,
  effectiveFrom: component.effectiveFrom || null,
});

const isCalculationChange = (before = {}, after = {}) =>
  CALCULATION_FIELDS.some((field) => {
    const left = before[field];
    const right = after[field];
    if (field === 'formula') return JSON.stringify(left || null) !== JSON.stringify(right || null);
    return left !== right;
  });

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const makeSalaryComponentService = ({
  SalaryComponentModel,
  PayrollSetupModel = null,
  // Phase 29.3 — how many CURRENT salary structures reference a component.
  // Injected (not imported) so this module stays hermetic and testable.
  structureUsage = null,
  cache = {},
  audit = async () => null,
} = {}) => {
  const buildCacheKey = (companyId, segments = ['list']) => {
    const builder = cache.buildKey;
    if (typeof builder === 'function') {
      return builder({ companyId, namespace: CACHE_NAMESPACE, version: CACHE_VERSION, segments });
    }
    return null;
  };

  // Cache read with fail-open semantics: any Redis problem falls through
  // to MongoDB and the response still succeeds (§40).
  const loadTenantComponents = async (companyId) => {
    const key = buildCacheKey(companyId);
    const loader = async () =>
      SalaryComponentModel.find({ companyId, isCurrent: true })
        .sort({ category: 1, name: 1 })
        .lean();

    if (typeof cache.getOrSet !== 'function' || !key) {
      return { value: await loader(), cache: 'BYPASS' };
    }

    try {
      return await cache.getOrSet(key, {
        ttlSeconds: getComponentCacheTtlSeconds(),
        version: CACHE_VERSION,
        loader,
      });
    } catch {
      return { value: await loader(), cache: 'BYPASS' };
    }
  };

  const invalidate = async (companyId) => {
    const key = buildCacheKey(companyId);
    if (!key || typeof cache.del !== 'function') return false;
    try {
      return Boolean(await cache.del(key));
    } catch {
      return false;
    }
  };

  const writeAudit = async (payload) => {
    try {
      await audit(payload);
    } catch {
      // Auditing must never break a payroll configuration write.
    }
  };

  // ── read ─────────────────────────────────────────────────────────────────

  const listComponents = async ({ companyId, query = {} }) => {
    const { value } = await loadTenantComponents(companyId);
    const { items, meta } = filterComponents(value || [], query);
    const codeToName = Object.fromEntries((value || []).map((c) => [c.code, c.name]));

    return {
      components: items.map((component) => ({
        ...component,
        calculationLabel: describeCalculation(component, codeToName),
      })),
      meta,
    };
  };

  const getComponent = async ({ companyId, componentId }) => {
    const component = await SalaryComponentModel.findOne({ _id: componentId, companyId }).lean();
    if (!component) return null;

    const usage = await getUsage({ companyId, componentId: component._id });
    return { ...component, usage, calculationLabel: describeCalculation(component, {}) };
  };

  // §22 / §49 — where is this component used?
  const countStructures = async (companyId, componentCode) => {
    if (typeof structureUsage !== 'function' || !componentCode) return 0;
    try {
      return Number(await structureUsage({ companyId, componentCode })) || 0;
    } catch {
      return 0;
    }
  };

  const getUsage = async ({ companyId, componentId }) => {
    const component = await SalaryComponentModel.findOne({ _id: componentId, companyId })
      .select('_id code version')
      .lean();

    if (!component) return null;

    return {
      // Live count from Phase 29.3 — structures are the first consumer of a
      // component, so a component inside a structure is history-protected.
      structures: await countStructures(companyId, component.code),
      activeAssignments: 0,
      payrollRuns: 0,
      hasProcessedPayroll: false,
      // A component that already went through a version bump has history
      // behind it and must never be edited destructively.
      hasHistoricalVersions: Number(component.version || 1) > 1,
    };
  };

  const getDefaultSuggestions = async ({ companyId }) => {
    const setup = PayrollSetupModel
      ? await PayrollSetupModel.findOne({ companyId, isCurrent: true }).select('statutory').lean()
      : null;

    return suggestDefaultComponents(setup?.statutory || {});
  };

  // ── create ───────────────────────────────────────────────────────────────

  const createComponent = async ({ companyId, payload = {}, actor, req }) => {
    const { value: existing } = await loadTenantComponents(companyId);
    const component = normalizeSalaryComponent(payload);

    const errors = validateSalaryComponent(component, {
      existingCodes: (existing || []).map((c) => c.code),
    });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    // §7 — no two ACTIVE components with the same name in one company.
    const duplicateName = (existing || []).find(
      (c) => c.status === 'ACTIVE' && String(c.name).trim().toLowerCase() === component.name.toLowerCase(),
    );
    if (duplicateName) {
      throw ApiError.conflict('An active component with this name already exists. Please choose another name.');
    }

    // §14 — circular dependency check across the tenant's components.
    const cycle = detectCircularDependency(component, existing || []);
    if (cycle) throw ApiError.badRequest('This configuration creates a circular salary dependency.');

    const doc = await SalaryComponentModel.create({
      ...component,
      companyId,
      version: 1,
      isCurrent: true,
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'SALARY_COMPONENT_CREATED',
      companyId,
      resource: 'SalaryComponent',
      resourceId: doc._id,
      previousValue: null,
      newValue: snapshot(doc),
    });

    return doc;
  };

  // ── update (with versioning when history exists) ──────────────────────────

  const updateComponent = async ({ companyId, componentId, payload = {}, actor, req }) => {
    const current = await SalaryComponentModel.findOne({ _id: componentId, companyId });
    if (!current) throw ApiError.notFound('Salary component not found');

    const { value: existing } = await loadTenantComponents(companyId);
    const merged = normalizeSalaryComponent({ ...current.toObject(), ...payload });

    const errors = validateSalaryComponent(merged, {
      existingCodes: (existing || []).map((c) => c.code),
      selfCode: current.code,
    });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    const cycle = detectCircularDependency(
      merged,
      (existing || []).map((c) => (c.code === current.code ? merged : c)),
    );
    if (cycle) throw ApiError.badRequest('This configuration creates a circular salary dependency.');

    const usage = await getUsage({ companyId, componentId: current._id });
    const changesCalculation = isCalculationChange(snapshot(current), snapshot(merged));
    const mustVersion =
      changesCalculation && (usage?.hasProcessedPayroll || usage?.hasHistoricalVersions || usage?.structures > 0);

    const previousSnapshot = snapshot(current);

    if (mustVersion) {
      // §24 / §31 / §58 — never rewrite history: close the old version and
      // write the new configuration as a new effective-dated row.
      current.isCurrent = false;
      current.effectiveTo = merged.effectiveFrom || new Date();
      current.updatedBy = actor?._id || null;
      await current.save();

      const doc = await SalaryComponentModel.create({
        ...merged,
        companyId,
        version: Number(current.version || 1) + 1,
        isCurrent: true,
        previousVersionId: current._id,
        createdBy: actor?._id || null,
        updatedBy: actor?._id || null,
      });

      await invalidate(companyId);
      await writeAudit({
        req,
        action: 'SALARY_COMPONENT_NEW_VERSION',
        companyId,
        resource: 'SalaryComponent',
        resourceId: doc._id,
        previousValue: previousSnapshot,
        newValue: snapshot(doc),
      });

      return { component: doc, versioned: true };
    }

    Object.assign(current, {
      ...merged,
      updatedBy: actor?._id || null,
    });
    await current.save();

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'SALARY_COMPONENT_UPDATED',
      companyId,
      resource: 'SalaryComponent',
      resourceId: current._id,
      previousValue: previousSnapshot,
      newValue: snapshot(current),
    });

    return { component: current, versioned: false };
  };

  // ── lifecycle (§20 / §33 / §34) ───────────────────────────────────────────

  const setStatus = async ({ companyId, componentId, status, actor, req }) => {
    const wanted = String(status || '').toUpperCase();
    if (!COMPONENT_STATUS.includes(wanted)) throw ApiError.badRequest('Status must be Active or Inactive');

    const component = await SalaryComponentModel.findOne({ _id: componentId, companyId });
    if (!component) throw ApiError.notFound('Salary component not found');

    if (component.status === wanted) return { component, changed: false };

    const previousSnapshot = snapshot(component);
    component.status = wanted;
    component.updatedBy = actor?._id || null;
    await component.save();

    await invalidate(companyId);
    await writeAudit({
      req,
      action: wanted === 'ACTIVE' ? 'SALARY_COMPONENT_ACTIVATED' : 'SALARY_COMPONENT_DEACTIVATED',
      companyId,
      resource: 'SalaryComponent',
      resourceId: component._id,
      previousValue: previousSnapshot,
      newValue: snapshot(component),
    });

    return { component, changed: true };
  };

  // ── duplicate (§32) ───────────────────────────────────────────────────────

  const duplicateComponent = async ({ companyId, componentId, payload = {}, actor, req }) => {
    const source = await SalaryComponentModel.findOne({ _id: componentId, companyId }).lean();
    if (!source) throw ApiError.notFound('Salary component not found');

    const { value: existing } = await loadTenantComponents(companyId);
    const { _id, createdAt, updatedAt, __v, ...clone } = source;

    const candidate = normalizeSalaryComponent({
      ...clone,
      ...payload,
      // A duplicate is always a fresh component: new identity, no history.
      name: payload.name || `${source.name} Copy`,
      code: payload.code ? upperCodeOrEmpty(payload.code) : upperCodeOrEmpty(`${source.code}_COPY`),
      version: 1,
      isCurrent: true,
      previousVersionId: null,
      isSystemDefault: false,
    });

    const errors = validateSalaryComponent(candidate, {
      existingCodes: (existing || []).map((c) => c.code),
    });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    const doc = await SalaryComponentModel.create({
      ...candidate,
      companyId,
      // A duplicate is a brand new component: fresh version, no lineage.
      version: 1,
      isCurrent: true,
      previousVersionId: null,
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'SALARY_COMPONENT_DUPLICATED',
      companyId,
      resource: 'SalaryComponent',
      resourceId: doc._id,
      previousValue: { sourceId: source._id, sourceCode: source.code },
      newValue: snapshot(doc),
    });

    return doc;
  };

  // ── defaults (§35 / §36) ──────────────────────────────────────────────────

  // Creates only the components the company does not have yet, and only the
  // statutory ones Phase 29.1 says are applicable. Never forced (§35).
  const createDefaults = async ({ companyId, actor, req }) => {
    const suggestions = await getDefaultSuggestions({ companyId });
    const { value: existing } = await loadTenantComponents(companyId);
    const existingCodes = new Set((existing || []).map((c) => c.code));

    const created = [];
    for (const suggestion of suggestions) {
      if (existingCodes.has(suggestion.code)) continue;
      try {
        const doc = await createComponent({ companyId, payload: suggestion, actor, req });
        created.push(doc);
        existingCodes.add(doc.code);
      } catch {
        // One rejected suggestion must not abort the rest.
      }
    }

    return { created, skipped: suggestions.length - created.length };
  };

  return {
    listComponents,
    getComponent,
    getUsage,
    getDefaultSuggestions,
    createComponent,
    updateComponent,
    setStatus,
    duplicateComponent,
    createDefaults,
    invalidate,
  };
};

// ── default instance wired to the real infrastructure ────────────────────────
// Tests use `makeSalaryComponentService` with fakes; the app uses this.
import SalaryComponent from '../../models/SalaryComponent.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import salaryStructureService from './salaryStructureService.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';

const salaryComponentService = makeSalaryComponentService({
  SalaryComponentModel: SalaryComponent,
  PayrollSetupModel: PayrollSetup,
  // 29.3 structures are the first real consumer of a component.
  structureUsage: ({ companyId, componentCode }) =>
    salaryStructureService.countStructuresUsingComponent({ companyId, componentCode }),
  cache: {
    buildKey: buildTenantCacheKey,
    getOrSet: getOrSetCache,
    del: async (key) => {
      const removed = await deleteCache(key);
      if (removed) noteCacheInvalidation();
      return removed;
    },
  },
  audit: recordAudit,
});

export default salaryComponentService;
