// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.3 — SALARY STRUCTURE SERVICE (tenant-safe persistence)
//
//  Write order (§21): validate → authorize (route) → tenant → dependencies
//  → save → invalidate cache → audit.
//
//  REDIS (§18): reuses the Phase 28 redisCacheService with the project's
//  tenant key convention (namespace 'payroll-structures'). MongoDB stays the
//  source of truth; a Redis failure only skips the cache.
//
//  BULLMQ (§19): no new queue. CRUD stays synchronous and the existing audit
//  infrastructure is used directly, exactly as in 29.1 / 29.2.
//
//  Dependency injection keeps the hermetic test suite free of MongoDB, Redis
//  and network.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import {
  CATEGORY_LABELS,
  canTransition,
  cloneStructurePayload,
  computeStructurePreview,
  filterStructures,
  normalizeSalaryStructure,
  upperCodeOrEmpty,
  validateAgainstGross,
  validateSalaryStructure,
} from './salaryStructureRules.js';

export const CACHE_NAMESPACE = 'payroll-structures';
export const CACHE_VERSION = 1;

const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const getStructureCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.SALARY_STRUCTURE_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

const snapshot = (structure = {}) => ({
  name: structure.name || '',
  code: structure.code || '',
  status: structure.status || '',
  departmentId: structure.departmentId || null,
  designation: structure.designation || '',
  effectiveFrom: structure.effectiveFrom || null,
  version: structure.version || 1,
  items: (structure.items || []).map((item) => ({
    componentCode: item.componentCode,
    calculationMethod: item.calculationMethod,
    value: item.value ?? null,
    order: item.order ?? 0,
  })),
});

// Configuration changes that must never rewrite payroll history (§12).
const isConfigurationChange = (before = {}, after = {}) =>
  JSON.stringify(before.items) !== JSON.stringify(after.items) ||
  before.departmentId !== after.departmentId ||
  before.designation !== after.designation;

export const makeSalaryStructureService = ({
  SalaryStructureModel,
  SalaryComponentModel,
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

  const loadTenantStructures = async (companyId) => {
    const loader = async () =>
      SalaryStructureModel.find({ companyId, isCurrent: true }).sort({ name: 1 }).lean();
    const key = buildCacheKey(companyId);

    if (typeof cache.getOrSet !== 'function' || !key) {
      return { value: await loader(), cache: 'BYPASS' };
    }

    try {
      return await cache.getOrSet(key, {
        ttlSeconds: getStructureCacheTtlSeconds(),
        version: CACHE_VERSION,
        loader,
      });
    } catch {
      return { value: await loader(), cache: 'BYPASS' };
    }
  };

  // Active components of THIS company only — §6 says never hardcode them.
  const loadActiveComponents = async (companyId) =>
    SalaryComponentModel.find({ companyId, status: 'ACTIVE', isCurrent: true })
      .sort({ name: 1 })
      .lean();

  const componentMap = (components = []) =>
    Object.fromEntries(components.map((component) => [upperCodeOrEmpty(component.code), component]));

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

  // ── usage (§17) ──────────────────────────────────────────────────────────

  // Employees are assigned in Phase 29.4, so the count is honestly 0 today.
  const getUsage = async ({ companyId, structureId }) => {
    const structure = await SalaryStructureModel.findOne({ _id: structureId, companyId })
      .select('_id code version departmentId')
      .lean();

    if (!structure) return null;

    const versions = await SalaryStructureModel.countDocuments({ companyId, code: structure.code });

    return {
      employees: 0,
      departments: structure.departmentId ? 1 : 0,
      versions: versions || Number(structure.version || 1),
      hasProcessedPayroll: false,
      hasHistoricalVersions: Number(structure.version || 1) > 1 || versions > 1,
    };
  };

  // How many CURRENT structures reference a component — used to protect the
  // component from destructive edits (closes the 29.2 → 29.3 loop).
  const countStructuresUsingComponent = async ({ companyId, componentCode }) => {
    const code = upperCodeOrEmpty(componentCode);
    if (!code) return 0;
    return SalaryStructureModel.countDocuments({
      companyId,
      isCurrent: true,
      'items.componentCode': code,
    });
  };

  // ── reads ────────────────────────────────────────────────────────────────

  const listStructures = async ({ companyId, query = {} }) => {
    const [{ value: structures }, components] = await Promise.all([
      loadTenantStructures(companyId),
      loadActiveComponents(companyId),
    ]);

    const { items, meta } = filterStructures(structures || [], query);
    const map = componentMap(components);

    const enriched = items.map((structure) => {
      const counts = (structure.items || []).reduce(
        (acc, item) => {
          const category = map[upperCodeOrEmpty(item.componentCode)]?.category;
          if (category === 'EARNING') acc.earnings += 1;
          else if (category === 'DEDUCTION') acc.deductions += 1;
          else if (category === 'EMPLOYER_CONTRIBUTION') acc.employerContributions += 1;
          return acc;
        },
        { earnings: 0, deductions: 0, employerContributions: 0 },
      );

      return {
        ...structure,
        componentCount: (structure.items || []).length,
        ...counts,
      };
    });

    return { structures: enriched, meta, components };
  };

  const getStructure = async ({ companyId, structureId }) => {
    const structure = await SalaryStructureModel.findOne({ _id: structureId, companyId }).lean();
    if (!structure) return null;

    const [components, usage, history] = await Promise.all([
      loadActiveComponents(companyId),
      getUsage({ companyId, structureId }),
      SalaryStructureModel.find({ companyId, code: structure.code })
        .sort({ version: -1 })
        .select('version status effectiveFrom effectiveTo isCurrent createdAt')
        .lean(),
    ]);

    return { ...structure, usage, history, components };
  };

  // §9 — display-only preview, never persisted.
  const previewStructure = async ({ companyId, items = [], gross = 0 }) => {
    const components = await loadActiveComponents(companyId);
    return computeStructurePreview({ items, components: componentMap(components), gross });
  };

  // ── writes ───────────────────────────────────────────────────────────────

  const createStructure = async ({ companyId, payload = {}, actor, req }) => {
    const [components, existing] = await Promise.all([
      loadActiveComponents(companyId),
      loadTenantStructures(companyId),
    ]);

    const structure = normalizeSalaryStructure(payload);
    const map = componentMap(components);

    const errors = validateSalaryStructure(structure, {
      components: map,
      existingCodes: (existing.value || []).map((row) => row.code),
    });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    const grossErrors = validateAgainstGross(structure.items, map, payload.sampleGross);
    if (grossErrors.length) throw ApiError.badRequest(grossErrors[0].message, grossErrors);

    const duplicateName = (existing.value || []).find(
      (row) => String(row.name).trim().toLowerCase() === structure.name.toLowerCase(),
    );
    if (duplicateName) {
      throw ApiError.conflict('An active structure with this name already exists. Please choose another name.');
    }

    const doc = await SalaryStructureModel.create({
      ...structure,
      companyId,
      version: 1,
      isCurrent: true,
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'SALARY_STRUCTURE_CREATED',
      companyId,
      resource: 'SalaryStructure',
      resourceId: doc._id,
      previousValue: null,
      newValue: snapshot(doc),
    });

    return doc;
  };

  const updateStructure = async ({ companyId, structureId, payload = {}, actor, req }) => {
    const current = await SalaryStructureModel.findOne({ _id: structureId, companyId });
    if (!current) throw ApiError.notFound('Salary structure not found');

    const [components, existing] = await Promise.all([
      loadActiveComponents(companyId),
      loadTenantStructures(companyId),
    ]);

    const merged = normalizeSalaryStructure({ ...current.toObject(), ...payload });
    const map = componentMap(components);

    const errors = validateSalaryStructure(merged, {
      components: map,
      existingCodes: (existing.value || []).map((row) => row.code),
      selfCode: current.code,
    });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    const grossErrors = validateAgainstGross(merged.items, map, payload.sampleGross);
    if (grossErrors.length) throw ApiError.badRequest(grossErrors[0].message, grossErrors);

    const usage = await getUsage({ companyId, structureId: current._id });
    const previousSnapshot = snapshot(current);
    const changesConfiguration = isConfigurationChange(previousSnapshot, snapshot(merged));
    const mustVersion = changesConfiguration && (usage?.hasProcessedPayroll || usage?.hasHistoricalVersions);

    if (mustVersion) {
      // §12 — close the old version and write the new one.
      current.isCurrent = false;
      current.effectiveTo = merged.effectiveFrom || new Date();
      current.updatedBy = actor?._id || null;
      await current.save();

      const doc = await SalaryStructureModel.create({
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
        action: 'SALARY_STRUCTURE_NEW_VERSION',
        companyId,
        resource: 'SalaryStructure',
        resourceId: doc._id,
        previousValue: previousSnapshot,
        newValue: snapshot(doc),
      });

      return { structure: doc, versioned: true };
    }

    Object.assign(current, { ...merged, updatedBy: actor?._id || null });
    await current.save();

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'SALARY_STRUCTURE_UPDATED',
      companyId,
      resource: 'SalaryStructure',
      resourceId: current._id,
      previousValue: previousSnapshot,
      newValue: snapshot(current),
    });

    return { structure: current, versioned: false };
  };

  const setStatus = async ({ companyId, structureId, status, actor, req }) => {
    const wanted = String(status || '').toUpperCase();
    const structure = await SalaryStructureModel.findOne({ _id: structureId, companyId });
    if (!structure) throw ApiError.notFound('Salary structure not found');

    if (!canTransition(structure.status, wanted)) {
      throw ApiError.badRequest(
        `A ${structure.status.toLowerCase()} structure cannot become ${wanted.toLowerCase()}.`,
      );
    }

    const previousSnapshot = snapshot(structure);
    structure.status = wanted;
    structure.updatedBy = actor?._id || null;
    await structure.save();

    await invalidate(companyId);
    await writeAudit({
      req,
      action: `SALARY_STRUCTURE_${wanted}`,
      companyId,
      resource: 'SalaryStructure',
      resourceId: structure._id,
      previousValue: previousSnapshot,
      newValue: snapshot(structure),
    });

    return structure;
  };

  // §13 — clone copies configuration only, never usage or history.
  const cloneStructure = async ({ companyId, structureId, payload = {}, actor, req }) => {
    const source = await SalaryStructureModel.findOne({ _id: structureId, companyId }).lean();
    if (!source) throw ApiError.notFound('Salary structure not found');

    const existing = await loadTenantStructures(companyId);
    const candidate = cloneStructurePayload(source, {
      name: payload.name,
      code: payload.code,
      effectiveFrom: payload.effectiveFrom,
    });

    const components = await loadActiveComponents(companyId);
    const errors = validateSalaryStructure(candidate, {
      components: componentMap(components),
      existingCodes: (existing.value || []).map((row) => row.code),
    });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    const doc = await SalaryStructureModel.create({
      ...candidate,
      companyId,
      version: 1,
      isCurrent: true,
      previousVersionId: null,
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'SALARY_STRUCTURE_CLONED',
      companyId,
      resource: 'SalaryStructure',
      resourceId: doc._id,
      previousValue: { sourceId: source._id, sourceCode: source.code },
      newValue: snapshot(doc),
    });

    return doc;
  };

  return {
    listStructures,
    getStructure,
    previewStructure,
    getUsage,
    countStructuresUsingComponent,
    createStructure,
    updateStructure,
    setStatus,
    cloneStructure,
    invalidate,
    CATEGORY_LABELS,
  };
};

import SalaryStructureTemplate from '../../models/SalaryStructureTemplate.js';
import SalaryComponent from '../../models/SalaryComponent.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';

// Default instance wired to the real infrastructure (tests build their own).
const salaryStructureService = makeSalaryStructureService({
  SalaryStructureModel: SalaryStructureTemplate,
  SalaryComponentModel: SalaryComponent,
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

export default salaryStructureService;
