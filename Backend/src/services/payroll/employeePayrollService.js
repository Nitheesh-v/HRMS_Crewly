// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.4 — EMPLOYEE PAYROLL PROFILE SERVICE (tenant-safe persistence)
//
//  Write order: validate → authorize (route) → tenant → dependencies → save
//  → invalidate cache → audit → notify.
//
//  REDIS (§20): reuses the Phase 28 redisCacheService with the project's
//  tenant key convention (namespace 'payroll-employee'). MongoDB remains the
//  source of truth; a Redis failure only skips the cache.
//
//  BULLMQ (§21): no new queue. Audit is synchronous (29.1 / 29.2 / 29.3
//  discipline) and notifications go through the existing notifySmart seam,
//  exactly like the 29.1 setup-activation notification.
//
//  Dependency injection keeps the hermetic suite free of MongoDB and Redis.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import { decryptSensitiveValue, encryptSensitiveValue } from '../../utils/fieldEncryption.js';
import {
  canChangePayrollStatus,
  computeEmployeePayrollPreview,
  isSalaryRevision,
  maskAccountNumber,
  normalizeEmployeePayroll,
  redactForAudit,
  serializeEmployeePayroll,
  validateEmployeePayroll,
} from './employeePayrollRules.js';

export const CACHE_NAMESPACE = 'payroll-employee';
export const CACHE_VERSION = 1;

const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const getPayrollProfileCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.EMPLOYEE_PAYROLL_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

// Audit-safe snapshot: identity numbers are never written (project rule).
const auditSnapshot = (profile = {}) => ({
  annualCtc: profile.annualCtc || 0,
  monthlyGross: profile.monthlyGross || 0,
  payrollStatus: profile.payrollStatus || '',
  structureId: profile.structureId || null,
  employmentType: profile.employmentType || '',
  payGroup: profile.payGroup || '',
  effectiveFrom: profile.effectiveFrom || null,
  version: profile.version || 1,
  bank: {
    bankName: profile.bank?.bankName || '',
    ifsc: profile.bank?.ifsc || '',
    accountNumber: redactForAudit(profile.bank?.accountNumber),
    accountNumberMasked: profile.bank?.accountNumberMasked || '',
  },
  statutory: {
    pan: redactForAudit(profile.statutory?.pan),
    uan: redactForAudit(profile.statutory?.uan),
    esiNumber: redactForAudit(profile.statutory?.esiNumber),
    aadhaar: redactForAudit(profile.statutory?.aadhaar),
    pfMember: Boolean(profile.statutory?.pfMember),
    gratuityEligible: Boolean(profile.statutory?.gratuityEligible),
  },
  tax: { ...(profile.tax || {}) },
});

export const makeEmployeePayrollService = ({
  EmployeePayrollProfileModel,
  SalaryStructureTemplateModel,
  SalaryComponentModel,
  PayrollSetupModel = null,
  UserModel = null,
  cache = {},
  audit = async () => null,
  notify = async () => null,
} = {}) => {
  const buildCacheKey = (companyId) => {
    const builder = cache.buildKey;
    if (typeof builder === 'function') {
      return builder({ companyId, namespace: CACHE_NAMESPACE, version: CACHE_VERSION });
    }
    return null;
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

  const loadTenantProfiles = async (companyId) => {
    const loader = async () =>
      EmployeePayrollProfileModel.find({ companyId, isCurrent: true })
        .sort({ updatedAt: -1 })
        .lean();
    const key = buildCacheKey(companyId);

    if (typeof cache.getOrSet !== 'function' || !key) {
      return { value: await loader(), cache: 'BYPASS' };
    }

    try {
      return await cache.getOrSet(key, {
        ttlSeconds: getPayrollProfileCacheTtlSeconds(),
        version: CACHE_VERSION,
        loader,
      });
    } catch {
      return { value: await loader(), cache: 'BYPASS' };
    }
  };

  const writeAudit = async (payload) => {
    try {
      await audit(payload);
    } catch {
      // Auditing must never break a payroll write.
    }
  };

  const notifySafe = async (payload) => {
    try {
      await notify(payload);
    } catch {
      // Notifications are best-effort.
    }
  };

  // §11 — statutory applicability is READ from 29.1, never duplicated.
  const loadStatutory = async (companyId) => {
    if (!PayrollSetupModel) return {};
    try {
      const setup = await PayrollSetupModel.findOne({ companyId, isCurrent: true })
        .select('statutory payrollCycle currency')
        .lean();
      return setup?.statutory || {};
    } catch {
      return {};
    }
  };

  const loadStructure = async (companyId, structureId) => {
    if (!structureId) return null;
    const structure = await SalaryStructureTemplateModel.findOne({
      _id: structureId,
      companyId,
      status: 'ACTIVE',
      isCurrent: true,
    }).lean();
    if (!structure) return null;

    // The preview needs component categories, resolved for THIS company.
    const components = SalaryComponentModel
      ? await SalaryComponentModel.find({ companyId, status: 'ACTIVE', isCurrent: true })
          .select('code name category')
          .lean()
      : [];

    return {
      ...structure,
      componentMap: Object.fromEntries(components.map((component) => [component.code, component])),
    };
  };

  const versionsFor = async (companyId, employeeId) =>
    EmployeePayrollProfileModel.find({ companyId, employeeId })
      .select('version effectiveFrom effectiveTo annualCtc monthlyGross payrollStatus isCurrent createdAt')
      .sort({ version: -1 })
      .lean();

  // ── reads ────────────────────────────────────────────────────────────────

  const listProfiles = async ({ companyId, query = {} }) => {
    const [{ value }, structures] = await Promise.all([
      loadTenantProfiles(companyId),
      SalaryStructureTemplateModel.find({ companyId, isCurrent: true })
        .select('name code status')
        .lean(),
    ]);

    const shapes = value || [];
    const structureNames = Object.fromEntries(
      structures.map((structure) => [String(structure._id), structure.name]),
    );

    // One query for the people on the list AND the people who still need a
    // profile, so the UI can start one without a second round trip (§5).
    const employees = UserModel
      ? await UserModel.find({ companyId, status: 'ACTIVE' })
          .select('name email employeeCode department designation')
          .sort({ name: 1 })
          .lean()
      : [];

    const byEmployee = Object.fromEntries(employees.map((row) => [String(row._id), row]));
    const withProfile = new Set(shapes.map((row) => String(row.employeeId)));

    return {
      profiles: shapes
        .filter((row) => byEmployee[String(row.employeeId)])
        .map((row) => {
          const employee = byEmployee[String(row.employeeId)] || {};
          return serializeEmployeePayroll({
            ...row,
            employeeName: employee.name || '',
            employeeCode: employee.employeeCode || '',
            email: employee.email || '',
            departmentId: employee.department || null,
            designation: row.designation || employee.designation || '',
            structureName: structureNames[String(row.structureId)] || row.structureName || '',
          });
        }),
      structures,
      employees,
      withoutProfile: employees.filter((row) => !withProfile.has(String(row._id))),
    };
  };

  const getProfile = async ({ companyId, employeeId }) => {
    const profile = await EmployeePayrollProfileModel.findOne({
      companyId,
      employeeId,
      isCurrent: true,
    })
      .select('+bank.accountNumber')
      .lean();

    if (!profile) return null;

    const [history, structure, statutory] = await Promise.all([
      versionsFor(companyId, employeeId),
      loadStructure(companyId, profile.structureId),
      loadStatutory(companyId),
    ]);

    return {
      ...serializeEmployeePayroll(profile),
      history,
      preview: computeEmployeePayrollPreview({
        structure,
        monthlyGross: profile.monthlyGross,
      }),
      statutoryConfig: statutory,
    };
  };

  // §9 — preview only. Nothing is stored and no payroll is calculated.
  const previewProfile = async ({ companyId, structureId, monthlyGross }) => {
    const structure = await loadStructure(companyId, structureId);
    if (!structure) throw ApiError.badRequest('Select an active salary structure first');

    return computeEmployeePayrollPreview({ structure, monthlyGross });
  };

  // ── write helpers ────────────────────────────────────────────────────────

  const applyBank = (existing = {}, incoming = {}) => {
    const bank = { ...(existing.bank || {}), ...incoming.bank };
    const provided = incoming.bank?.accountNumber;

    if (provided) {
      bank.accountNumber = encryptSensitiveValue(provided);
      bank.accountNumberLast4 = String(provided).slice(-4);
      bank.accountNumberMasked = maskAccountNumber(provided);
    } else {
      // Keep whatever is already stored.
      bank.accountNumber = existing.bank?.accountNumber || '';
      bank.accountNumberLast4 = existing.bank?.accountNumberLast4 || '';
      bank.accountNumberMasked = existing.bank?.accountNumberMasked || '';
    }

    return bank;
  };

  // ── create / update (§5 / §7 / §15) ───────────────────────────────────────

  const saveProfile = async ({ companyId, employeeId, payload = {}, actor, req }) => {
    const current = await EmployeePayrollProfileModel.findOne({
      companyId,
      employeeId,
      isCurrent: true,
    }).select('+bank.accountNumber');

    const stored = current?.toObject?.() || {};

    // The stored account number is ENCRYPTED, so it must never be fed back
    // into normalization as if it were a candidate plain value (§24).
    const incoming = normalizeEmployeePayroll({
      ...stored,
      ...payload,
      bank: {
        ...(stored.bank || {}),
        ...(payload.bank || {}),
        accountNumber: payload.bank?.accountNumber || '',
      },
    });
    const bank = applyBank(stored, { bank: payload.bank });

    const structure = await loadStructure(companyId, incoming.structureId);
    const statutoryConfig = await loadStatutory(companyId);
    const versions = current ? await versionsFor(companyId, employeeId) : [];

    const errors = validateEmployeePayroll(
      {
        ...incoming,
        bank: {
          ...incoming.bank,
          hasStoredAccount: Boolean(current?.bank?.accountNumber || bank.accountNumber),
        },
      },
      {
        statutory: statutoryConfig,
        structure,
        existingVersions: versions,
        selfEffectiveFrom: current?.effectiveFrom || null,
      },
    );

    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    const previousSnapshot = current ? auditSnapshot(current.toObject()) : null;

    const next = {
      ...incoming,
      companyId,
      employeeId,
      bank,
      structureName: structure?.name || '',
      breakdown: computeEmployeePayrollPreview({
        structure,
        monthlyGross: incoming.monthlyGross,
      }),
      updatedBy: actor?._id || null,
    };

    // §15 — money or structure changed on an existing profile ⇒ new version.
    const revision = Boolean(current) && isSalaryRevision(current.toObject(), incoming);

    if (revision) {
      current.isCurrent = false;
      current.effectiveTo = incoming.effectiveFrom;
      current.updatedBy = actor?._id || null;
      await current.save();

      const created = await EmployeePayrollProfileModel.create({
        ...next,
        version: Number(current.version || 1) + 1,
        isCurrent: true,
        previousVersionId: current._id,
        createdBy: actor?._id || null,
      });

      await invalidate(companyId);
      await writeAudit({
        req,
        action: 'EMPLOYEE_SALARY_REVISED',
        companyId,
        resource: 'EmployeePayrollProfile',
        resourceId: created._id,
        previousValue: previousSnapshot,
        newValue: auditSnapshot(created),
      });
      await notifySafe({
        userId: employeeId,
        companyId,
        type: 'SALARY_REVISED',
        title: 'Your salary has been revised',
        message: `A new salary version (v${created.version}) is effective from ${new Date(created.effectiveFrom).toLocaleDateString('en-IN')}.`,
      });

      return { profile: created, revision: true };
    }

    if (current) {
      Object.assign(current, next);
      await current.save();

      await invalidate(companyId);
      await writeAudit({
        req,
        action: 'EMPLOYEE_PAYROLL_UPDATED',
        companyId,
        resource: 'EmployeePayrollProfile',
        resourceId: current._id,
        previousValue: previousSnapshot,
        newValue: auditSnapshot(current),
      });

      return { profile: current, revision: false };
    }

    const created = await EmployeePayrollProfileModel.create({
      ...next,
      version: 1,
      isCurrent: true,
      createdBy: actor?._id || null,
    });

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'EMPLOYEE_PAYROLL_CREATED',
      companyId,
      resource: 'EmployeePayrollProfile',
      resourceId: created._id,
      previousValue: null,
      newValue: auditSnapshot(created),
    });

    return { profile: created, revision: false };
  };

  // ── status (§14) ─────────────────────────────────────────────────────────

  const setStatus = async ({ companyId, employeeId, status, actor, req }) => {
    const wanted = String(status || '').toUpperCase();
    const profile = await EmployeePayrollProfileModel.findOne({
      companyId,
      employeeId,
      isCurrent: true,
    }).select('+bank.accountNumber');

    if (!profile) throw ApiError.notFound('Payroll profile not found');

    if (!canChangePayrollStatus(profile.payrollStatus, wanted)) {
      throw ApiError.badRequest(
        `A ${profile.payrollStatus.toLowerCase().replace('_', ' ')} profile cannot become ${wanted.toLowerCase().replace('_', ' ')}.`,
      );
    }

    // Activating re-runs the statutory checks (§11 / §23).
    if (wanted === 'ACTIVE') {
      const [structure, statutoryConfig] = await Promise.all([
        loadStructure(companyId, profile.structureId),
        loadStatutory(companyId),
      ]);

      // Same rule here: never normalize the encrypted value back as input.
      const candidate = normalizeEmployeePayroll({
        ...profile.toObject(),
        bank: { ...(profile.toObject().bank || {}), accountNumber: '' },
      });
      const errors = validateEmployeePayroll(
        {
          ...candidate,
          payrollStatus: wanted,
          bank: {
            ...candidate.bank,
            hasStoredAccount: Boolean(profile.bank?.accountNumber),
          },
        },
        { statutory: statutoryConfig, structure },
      );

      if (errors.length) throw ApiError.badRequest(errors[0].message, errors);
    }

    const previousSnapshot = auditSnapshot(profile);
    profile.payrollStatus = wanted;
    profile.updatedBy = actor?._id || null;
    if (wanted === 'ACTIVE') profile.activatedAt = new Date();
    await profile.save();

    await invalidate(companyId);
    await writeAudit({
      req,
      action: `EMPLOYEE_PAYROLL_${wanted}`,
      companyId,
      resource: 'EmployeePayrollProfile',
      resourceId: profile._id,
      previousValue: previousSnapshot,
      newValue: auditSnapshot(profile),
    });

    if (wanted === 'ACTIVE') {
      await notifySafe({
        userId: employeeId,
        companyId,
        type: 'PAYROLL_ACTIVATED',
        title: 'Your payroll profile is active',
        message: 'Your payroll profile is now active and ready for monthly payroll.',
      });
    }

    return profile;
  };

  // ── §19 — recruitment creates the draft profile during conversion ─────────

  const createFromOffer = async ({ companyId, employeeId, offer = {}, actor, req }) => {
    if (!employeeId) return null;

    const existing = await EmployeePayrollProfileModel.findOne({
      companyId,
      employeeId,
      isCurrent: true,
    }).lean();
    if (existing) return existing;

    const annualCtc = Number(offer?.compensationSnapshot?.annualCTC || offer?.annualCTC || 0);
    if (!annualCtc) return null;

    // Default pay group follows the company's 29.1 payroll cycle (§13).
    const setup = PayrollSetupModel
      ? await PayrollSetupModel.findOne({ companyId, isCurrent: true })
          .select('payrollCycle')
          .lean()
      : null;
    const payGroup =
      setup?.payrollCycle?.frequency === 'WEEKLY'
        ? 'WEEKLY'
        : setup?.payrollCycle?.frequency === 'BI_WEEKLY'
          ? 'WEEKLY'
          : 'MONTHLY';

    const profile = await EmployeePayrollProfileModel.create({
      companyId,
      employeeId,
      annualCtc,
      monthlyGross: Math.round(annualCtc / 12),
      payGroup,
      payrollStatus: 'DRAFT',
      designation: offer?.designation || '',
      employmentType: 'FULL_TIME',
      effectiveFrom: offer?.dateOfJoining ? new Date(offer.dateOfJoining) : new Date(),
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    await invalidate(companyId);
    await writeAudit({
      req,
      action: 'EMPLOYEE_PAYROLL_CREATED',
      companyId,
      resource: 'EmployeePayrollProfile',
      resourceId: profile._id,
      previousValue: null,
      newValue: { ...auditSnapshot(profile), source: 'CANDIDATE_CONVERSION' },
    });

    return profile;
  };

  return {
    listProfiles,
    getProfile,
    previewProfile,
    saveProfile,
    setStatus,
    createFromOffer,
    invalidate,
    decryptAccountNumber: decryptSensitiveValue,
  };
};

import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import SalaryComponent from '../../models/SalaryComponent.js';
import SalaryStructureTemplate from '../../models/SalaryStructureTemplate.js';
import User from '../../models/User.js';
import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';

// Default instance wired to the real infrastructure (tests build their own).
const employeePayrollService = makeEmployeePayrollService({
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  SalaryStructureTemplateModel: SalaryStructureTemplate,
  SalaryComponentModel: SalaryComponent,
  PayrollSetupModel: PayrollSetup,
  UserModel: User,
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
  // §21 — no new queue; the existing notification seam decides how to deliver.
  notify: ({ userId, title, message, type }) =>
    notifySmart(userId, {
      title,
      message,
      category: 'PAYROLL',
      metadata: { type },
    }),
});

export default employeePayrollService;
