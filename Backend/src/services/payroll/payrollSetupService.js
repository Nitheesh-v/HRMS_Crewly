// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 — COMPANY PAYROLL SETUP — SERVICE
//
//  Tenant rules (§2):
//    · The company ALWAYS comes from req.companyId (never from the body).
//    · Every read/write is filtered by { companyId, isCurrent: true }.
//    · There is no cross-tenant read path anywhere in this module.
//
//  Caching (§25/§26):
//    · MongoDB is the source of truth, Redis is only a cache.
//    · Reuses redisCacheService (Phase 28.7) — no second Redis client,
//      no second key convention: crewly:cache:company:<id>:payroll-setup:v1:current
//    · Fail-open: a dead Redis simply means "read from Mongo".
//
//  BullMQ (§27/§28):
//    · Setup save / activation are SYNCHRONOUS — the user never waits on a
//      queue job to save a setting.
//    · Only the activation side effect is background: the existing
//      notification/email path (notifySmart → existing email queue).
//    · No new queue, no new job name, no change to the Phase 28 registry.
//      notifyPayrollSetupActivated() is the single seam a later phase can
//      point at the BullMQ email outbox if needed.
// ═══════════════════════════════════════════════════════════════════════════

import PayrollSetup from '../../models/PayrollSetup.js';
import Company from '../../models/Company.js';
import User from '../../models/User.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../config/logger.js';
import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import { encryptSensitiveValue } from '../../utils/fieldEncryption.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';
import {
  ACTIVATABLE_STATUSES,
  PAYROLL_SETUP_SECTION_KEYS,
  canActivate,
  canTransition,
  defaultPayrollSetupConfiguration,
  digitsOnly,
  evaluateConfiguration,
  maskAccountNumber,
  normalizeCode,
  validateBankSection,
  validateLegalSection,
  validatePolicySection,
  validateStatutorySection,
  weekendPolicySummary,
} from './payrollSetupRules.js';

// ── Cache configuration ────────────────────────────────────────────────────

export const CACHE_NAMESPACE = 'payroll-setup';
export const CACHE_VERSION = 1;
const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const getSetupCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source.PAYROLL_SETUP_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

// Tenant-scoped, convention-compliant key. Returns null for an unsafe
// companyId → callers then bypass the cache entirely.
export const buildSetupCacheKey = (companyId) =>
  buildTenantCacheKey({
    companyId,
    namespace: CACHE_NAMESPACE,
    version: CACHE_VERSION,
    segments: ['current'],
  });

export const invalidatePayrollSetupCache = async (companyId) => {
  const key = buildSetupCacheKey(companyId);
  if (!key) return false;
  noteCacheInvalidation();
  const removed = await deleteCache(key);
  if (!removed) {
    // Cache is down or already gone — MongoDB is still the truth (§26).
    logger.debug('[PayrollSetup] cache invalidate no-op (Redis unavailable or key absent)');
  }
  return removed;
};

// ── Serialization (the ONLY shape that leaves the service) ─────────────────
// The full account number is never included — masked display only (§17).

const iso = (value) => (value ? new Date(value).toISOString() : null);
const str = (value) => (value === null || value === undefined ? null : String(value));

export const serializePayrollSetup = (doc) => {
  const plain = typeof doc?.toObject === 'function' ? doc.toObject() : { ...(doc || {}) };
  const bank = plain.bankAccount || {};

  return {
    id: str(plain._id),
    companyId: str(plain.companyId),
    status: plain.status || 'DRAFT',
    configVersion: Number(plain.configVersion) || 1,

    legal: {
      legalName: plain.legal?.legalName || '',
      pan: plain.legal?.pan || '',
      tan: plain.legal?.tan || '',
      gst: plain.legal?.gst || '',
      cin: plain.legal?.cin || '',
      addressLine: plain.legal?.addressLine || '',
      city: plain.legal?.city || '',
      state: plain.legal?.state || '',
      pincode: plain.legal?.pincode || '',
      country: plain.legal?.country || '',
    },

    statutory: {
      pf: {
        applicable: Boolean(plain.statutory?.pf?.applicable),
        establishmentNumber: plain.statutory?.pf?.establishmentNumber || '',
        registrationDate: iso(plain.statutory?.pf?.registrationDate),
      },
      esi: {
        applicable: Boolean(plain.statutory?.esi?.applicable),
        registrationNumber: plain.statutory?.esi?.registrationNumber || '',
      },
      professionalTax: {
        applicable: Boolean(plain.statutory?.professionalTax?.applicable),
        state: plain.statutory?.professionalTax?.state || '',
      },
      labourWelfareFund: {
        applicable: Boolean(plain.statutory?.labourWelfareFund?.applicable),
        state: plain.statutory?.labourWelfareFund?.state || '',
      },
      gratuity: { applicable: Boolean(plain.statutory?.gratuity?.applicable) },
      tds: { applicable: Boolean(plain.statutory?.tds?.applicable) },
    },

    payrollPolicy: {
      frequency: plain.payrollPolicy?.frequency || 'MONTHLY',
      cycleType: plain.payrollPolicy?.cycleType || 'FIXED_MONTH_DAY',
      cycleStartDay: Number(plain.payrollPolicy?.cycleStartDay) || 1,
      cycleEndDay: Number(plain.payrollPolicy?.cycleEndDay) || 31,
      paymentDateType: plain.payrollPolicy?.paymentDateType || 'SPECIFIC_DAY',
      paymentDayOfMonth: Number(plain.payrollPolicy?.paymentDayOfMonth) || 0,
      paymentMonthOffset: Number(plain.payrollPolicy?.paymentMonthOffset) || 0,
      currency: plain.payrollPolicy?.currency || 'INR',
      financialYearStartMonth: Number(plain.payrollPolicy?.financialYearStartMonth) || 4,
      weekendPolicy: {
        type: plain.payrollPolicy?.weekendPolicy?.type || 'SAT_SUN',
        customWorkingDays: plain.payrollPolicy?.weekendPolicy?.customWorkingDays || [],
      },
      lopPolicy: { basis: plain.payrollPolicy?.lopPolicy?.basis || 'PER_DAY' },
      overtimePolicy: {
        enabled: Boolean(plain.payrollPolicy?.overtimePolicy?.enabled),
        basis: plain.payrollPolicy?.overtimePolicy?.basis || 'HOURLY',
        multiplier: Number(plain.payrollPolicy?.overtimePolicy?.multiplier) || 1,
      },
      processingDeadlineDay: Number(plain.payrollPolicy?.processingDeadlineDay) || 0,
      lockRequiresReopen: plain.payrollPolicy?.lockRequiresReopen !== false,
    },

    bankAccount: {
      bankName: bank.bankName || '',
      accountHolderName: bank.accountHolderName || '',
      ifsc: bank.ifsc || '',
      branch: bank.branch || '',
      accountType: bank.accountType || 'CURRENT',
      paymentReferencePrefix: bank.paymentReferencePrefix || '',
      accountNumberLast4: bank.accountNumberLast4 || '',
      maskedAccountNumber: bank.accountNumberMasked || '',
      hasAccountNumber: Boolean(bank.accountNumberLast4),
    },

    setup: {
      currentStep: Number(plain.setup?.currentStep) || 1,
      completedSections: plain.setup?.completedSections || [],
      savedSections: plain.setup?.savedSections || [],
      lastSavedAt: iso(plain.setup?.lastSavedAt),
    },

    activation: {
      activatedAt: iso(plain.activation?.activatedAt),
      activatedBy: str(plain.activation?.activatedBy),
      suspendedAt: iso(plain.activation?.suspendedAt),
      suspendedBy: str(plain.activation?.suspendedBy),
      suspendReason: plain.activation?.suspendReason || '',
    },

    effectiveFrom: iso(plain.effectiveFrom),
    effectiveTo: iso(plain.effectiveTo),
    isCurrent: plain.isCurrent !== false,
    updatedAt: iso(plain.updatedAt),
    createdAt: iso(plain.createdAt),
  };
};

// Response for a company that has not started setup yet (§4/§30).
export const emptyPayrollSetupResponse = (companyId) => {
  const defaults = defaultPayrollSetupConfiguration();
  return {
    id: null,
    companyId: str(companyId),
    status: 'NOT_CONFIGURED',
    configVersion: 0,
    legal: defaults.legal,
    statutory: {
      pf: { ...defaults.statutory.pf, registrationDate: null },
      esi: { ...defaults.statutory.esi },
      professionalTax: { ...defaults.statutory.professionalTax },
      labourWelfareFund: { ...defaults.statutory.labourWelfareFund },
      gratuity: { ...defaults.statutory.gratuity },
      tds: { ...defaults.statutory.tds },
    },
    payrollPolicy: {
      ...defaults.payrollPolicy,
      weekendPolicy: { ...defaults.payrollPolicy.weekendPolicy, customWorkingDays: [] },
      lopPolicy: { ...defaults.payrollPolicy.lopPolicy },
      overtimePolicy: { ...defaults.payrollPolicy.overtimePolicy },
    },
    bankAccount: {
      ...defaults.bankAccount,
      accountNumberLast4: '',
      maskedAccountNumber: '',
      hasAccountNumber: false,
    },
    setup: { currentStep: 1, completedSections: [], savedSections: [], lastSavedAt: null },
    activation: {
      activatedAt: null,
      activatedBy: null,
      suspendedAt: null,
      suspendedBy: null,
      suspendReason: '',
    },
    effectiveFrom: null,
    effectiveTo: null,
    isCurrent: true,
    updatedAt: null,
    createdAt: null,
  };
};

// Human-readable summary used by the settings dashboard (§34).
export const summarizePayrollSetup = (config = {}) => {
  const weekend = weekendPolicySummary(config.payrollPolicy?.weekendPolicy);
  const paymentDateType = config.payrollPolicy?.paymentDateType;
  const day = config.payrollPolicy?.paymentDayOfMonth;
  const offset = Number(config.payrollPolicy?.paymentMonthOffset) || 0;
  const paymentLabel =
    paymentDateType === 'LAST_WORKING_DAY'
      ? 'Last working day'
      : `Day ${day}${offset === 1 ? ' of the following month' : ''}`;

  return {
    status: config.status,
    frequency: config.payrollPolicy?.frequency,
    cycle: `${config.payrollPolicy?.cycleStartDay}–${config.payrollPolicy?.cycleEndDay}`,
    paymentLabel,
    currency: config.payrollPolicy?.currency,
    financialYearStartMonth: config.payrollPolicy?.financialYearStartMonth,
    weekend: weekend.label,
    lopBasis: config.payrollPolicy?.lopPolicy?.basis,
    overtimeEnabled: Boolean(config.payrollPolicy?.overtimePolicy?.enabled),
    statutory: [
      config.statutory?.pf?.applicable ? 'PF' : null,
      config.statutory?.esi?.applicable ? 'ESI' : null,
      config.statutory?.professionalTax?.applicable ? 'PT' : null,
      config.statutory?.labourWelfareFund?.applicable ? 'LWF' : null,
      config.statutory?.gratuity?.applicable ? 'Gratuity' : null,
      config.statutory?.tds?.applicable ? 'TDS' : null,
    ].filter(Boolean),
    bank: {
      bankName: config.bankAccount?.bankName || '',
      maskedAccountNumber: config.bankAccount?.maskedAccountNumber || '',
      ifsc: config.bankAccount?.ifsc || '',
      paymentReferencePrefix: config.bankAccount?.paymentReferencePrefix || '',
    },
  };
};

// ── Side effects ───────────────────────────────────────────────────────────

const AUDIT_LABELS = {
  LEGAL: 'Payroll legal information updated',
  STATUTORY: 'Payroll statutory configuration updated',
  POLICY: 'Payroll policy updated',
  BANK: 'Payroll bank details updated',
};

// Bank audit values: masked only — never the account number (§24/§42).
const sanitizeForAudit = (section, value = {}) => {
  if (section !== 'BANK') {
    const copy = JSON.parse(JSON.stringify(value ?? {}));
    delete copy.accountNumber;
    return copy;
  }
  return {
    bankName: value.bankName,
    accountHolderName: value.accountHolderName,
    ifsc: value.ifsc,
    branch: value.branch,
    accountType: value.accountType,
    paymentReferencePrefix: value.paymentReferencePrefix,
    accountNumber: value.accountNumber || value.accountNumberLast4 ? '[MASKED]' : undefined,
  };
};

const writeAudit = ({ req, action, companyId, actor, resourceId, previousValue, newValue, critical = false, metadata = {} }) =>
  recordAudit({
    req,
    action,
    companyId,
    actorId: actor?.id || null,
    actorName: actor?.name || '',
    actorRole: actor?.role || '',
    resource: 'PAYROLL_SETUP',
    resourceId,
    previousValue,
    newValue,
    metadata,
    critical,
  });

// §41 — reuse the existing notification + email infrastructure.
// Never throws: a notification failure must not fail an activation.
export const notifyPayrollSetupActivated = async ({ companyId, companyName = 'your company', actorId = null }) => {
  const title = 'Payroll setup activated';
  const message = `Payroll setup for ${companyName} has been activated successfully.`;
  try {
    const admins = await User.find({
      companyId,
      role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER'] },
      status: 'ACTIVE',
    })
      .select('_id')
      .lean();

    await Promise.allSettled(
      admins.map((admin) =>
        notifySmart(admin._id, {
          title,
          message,
          link: '/app/payroll/setup',
          category: 'PAYROLL',
          emailText: message,
        }),
      ),
    );
    logger.info(`[PayrollSetup] activation notified admins count=${admins.length} company=${companyId}`);
    if (actorId) {
      await notifySmart(actorId, {
        title,
        message: `${message} You can now continue with salary components.`,
        link: '/app/payroll/setup',
        category: 'PAYROLL',
      });
    }
  } catch (error) {
    logger.warn(`[PayrollSetup] activation notification failed: ${error.message}`);
  }
};

// ── Read ───────────────────────────────────────────────────────────────────

export const getPayrollSetup = async ({
  companyId,
  io,
  PayrollSetupModel = PayrollSetup,
} = {}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');

  const loader = async () => {
    const doc = await PayrollSetupModel.findOne({ companyId, isCurrent: true }).lean();
    const config = doc ? serializePayrollSetup(doc) : emptyPayrollSetupResponse(companyId);
    return {
      config,
      evaluation: evaluateConfiguration(config, { savedSections: config.setup?.savedSections || [] }),
      summary: summarizePayrollSetup(config),
    };
  };

  const key = buildSetupCacheKey(companyId);
  const ttlSeconds = getSetupCacheTtlSeconds();

  // No valid key (unsafe companyId) → straight to Mongo, still correct.
  if (!key) {
    const value = await loader();
    return { ...value, cache: 'BYPASS' };
  }

  const { value, cache } = await getOrSetCache(key, {
    ttlSeconds,
    version: CACHE_VERSION,
    loader,
    io,
  });

  return { ...value, cache };
};

// ── Start (§4: NOT_CONFIGURED → DRAFT) ─────────────────────────────────────

export const startPayrollSetup = async ({
  companyId,
  actor = null,
  req = null,
  PayrollSetupModel = PayrollSetup,
  CompanyModel = Company,
  audit = writeAudit,
} = {}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');

  const existing = await PayrollSetupModel.findOne({ companyId, isCurrent: true });
  if (existing) {
    const config = serializePayrollSetup(existing);
    return { config, evaluation: evaluateConfiguration(config), started: false };
  }

  // Seed from the Company document (§6) — the company record stays the
  // source of truth for name/address; payroll only takes a snapshot.
  const company = await CompanyModel.findById(companyId)
    .select('name address country currency')
    .lean();

  const defaults = defaultPayrollSetupConfiguration();
  const seed = {
    companyId,
    status: 'DRAFT',
    legal: {
      ...defaults.legal,
      legalName: company?.name || '',
      addressLine: company?.address?.line || '',
      city: company?.address?.city || '',
      state: company?.address?.state || '',
      pincode: company?.address?.pincode || '',
      country: company?.country || defaults.legal.country,
    },
    payrollPolicy: {
      ...defaults.payrollPolicy,
      currency: normalizeCode(company?.currency) || defaults.payrollPolicy.currency,
    },
    bankAccount: { ...defaults.bankAccount },
    setup: { currentStep: 1, completedSections: [], savedSections: [], lastSavedAt: new Date() },
    createdBy: actor?.id || null,
    updatedBy: actor?.id || null,
    isCurrent: true,
  };

  let doc;
  try {
    doc = await PayrollSetupModel.findOneAndUpdate(
      { companyId, isCurrent: true },
      { $setOnInsert: seed },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
  } catch (error) {
    // Two admins clicked "Start" at once — the loser re-reads the winner.
    if (error?.code !== 11000) throw error;
    doc = await PayrollSetupModel.findOne({ companyId, isCurrent: true });
    if (!doc) throw error;
    const config = serializePayrollSetup(doc);
    return { config, evaluation: evaluateConfiguration(config), started: false };
  }

  await invalidatePayrollSetupCache(companyId);
  await audit({
    req,
    action: 'Payroll setup started',
    companyId,
    actor,
    resourceId: doc._id,
    newValue: { status: 'DRAFT' },
  });

  const config = serializePayrollSetup(doc);
  return { config, evaluation: evaluateConfiguration(config), started: true };
};

// ── Section patch builders (strict allow-lists) ────────────────────────────

const text = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const upper = (value, max = 20) => normalizeCode(value).slice(0, max);
const bool = (value) => value === true || value === 'true' || value === 1;
const intOr = (value, fallback) => {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const buildLegalPatch = (payload = {}, current = {}) => {
  const patch = {};
  if (payload.legalName !== undefined) patch['legal.legalName'] = text(payload.legalName, 160);
  if (payload.pan !== undefined) patch['legal.pan'] = upper(payload.pan, 10);
  if (payload.tan !== undefined) patch['legal.tan'] = upper(payload.tan, 10);
  if (payload.gst !== undefined) patch['legal.gst'] = upper(payload.gst, 15);
  if (payload.cin !== undefined) patch['legal.cin'] = upper(payload.cin, 21);
  if (payload.addressLine !== undefined) patch['legal.addressLine'] = text(payload.addressLine, 160);
  if (payload.city !== undefined) patch['legal.city'] = text(payload.city, 60);
  if (payload.state !== undefined) patch['legal.state'] = text(payload.state, 60);
  if (payload.pincode !== undefined) patch['legal.pincode'] = text(payload.pincode, 10);
  if (payload.country !== undefined) patch['legal.country'] = text(payload.country, 60);
  void current;
  return patch;
};

const buildStatutoryPatch = (payload = {}, current = {}) => {
  const patch = {};
  const merge = (key, fields) => {
    const incoming = payload[key];
    if (incoming === undefined) return;
    const base = current?.[key] || {};
    const next = { ...base };
    for (const field of fields) {
      if (incoming[field] === undefined) continue;
      next[field] = field === 'applicable' ? bool(incoming[field]) : text(incoming[field], 60);
    }
    patch[`statutory.${key}`] = next;
  };
  merge('pf', ['applicable', 'establishmentNumber']);
  merge('esi', ['applicable', 'registrationNumber']);
  merge('professionalTax', ['applicable', 'state']);
  merge('labourWelfareFund', ['applicable', 'state']);
  merge('gratuity', ['applicable']);
  merge('tds', ['applicable']);
  return patch;
};

const buildPolicyPatch = (payload = {}, current = {}) => {
  const patch = {};
  const set = (field, value) => {
    patch[`payrollPolicy.${field}`] = value;
  };

  if (payload.frequency !== undefined) set('frequency', upper(payload.frequency, 20));
  if (payload.cycleType !== undefined) set('cycleType', upper(payload.cycleType, 20));
  if (payload.cycleStartDay !== undefined) {
    set('cycleStartDay', intOr(payload.cycleStartDay, current.cycleStartDay ?? 1));
  }
  if (payload.cycleEndDay !== undefined) {
    set('cycleEndDay', intOr(payload.cycleEndDay, current.cycleEndDay ?? 31));
  }
  if (payload.paymentDateType !== undefined) set('paymentDateType', upper(payload.paymentDateType, 20));
  if (payload.paymentDayOfMonth !== undefined) {
    set('paymentDayOfMonth', intOr(payload.paymentDayOfMonth, current.paymentDayOfMonth ?? 30));
  }
  if (payload.paymentMonthOffset !== undefined) {
    set('paymentMonthOffset', intOr(payload.paymentMonthOffset, 0));
  }
  if (payload.currency !== undefined) set('currency', upper(payload.currency, 3));
  if (payload.financialYearStartMonth !== undefined) {
    set('financialYearStartMonth', intOr(payload.financialYearStartMonth, 4));
  }
  if (payload.processingDeadlineDay !== undefined) {
    set('processingDeadlineDay', intOr(payload.processingDeadlineDay, 25));
  }
  if (payload.lockRequiresReopen !== undefined) set('lockRequiresReopen', bool(payload.lockRequiresReopen));

  if (payload.weekendPolicy !== undefined) {
    const incoming = payload.weekendPolicy || {};
    const base = current.weekendPolicy || {};
    set('weekendPolicy', {
      type: incoming.type !== undefined ? upper(incoming.type, 20) : base.type || 'SAT_SUN',
      customWorkingDays: Array.isArray(incoming.customWorkingDays)
        ? incoming.customWorkingDays.map((day) => upper(day, 3)).slice(0, 7)
        : base.customWorkingDays || [],
    });
  }
  if (payload.lopPolicy !== undefined) {
    const incoming = payload.lopPolicy || {};
    const base = current.lopPolicy || {};
    set('lopPolicy', {
      basis: incoming.basis !== undefined ? upper(incoming.basis, 30) : base.basis || 'PER_DAY',
    });
  }
  if (payload.overtimePolicy !== undefined) {
    const incoming = payload.overtimePolicy || {};
    const base = current.overtimePolicy || {};
    const enabled = incoming.enabled !== undefined ? bool(incoming.enabled) : Boolean(base.enabled);
    const multiplier = incoming.multiplier !== undefined ? Number(incoming.multiplier) : Number(base.multiplier) || 1;
    set('overtimePolicy', {
      enabled,
      basis: incoming.basis !== undefined ? upper(incoming.basis, 20) : base.basis || 'HOURLY',
      multiplier: Number.isFinite(multiplier) ? multiplier : 1,
    });
  }
  return patch;
};

const buildBankPatch = (payload = {}, current = {}) => {
  const patch = {};
  if (payload.bankName !== undefined) patch['bankAccount.bankName'] = text(payload.bankName, 120);
  if (payload.accountHolderName !== undefined) {
    patch['bankAccount.accountHolderName'] = text(payload.accountHolderName, 120);
  }
  if (payload.ifsc !== undefined) patch['bankAccount.ifsc'] = upper(payload.ifsc, 11);
  if (payload.branch !== undefined) patch['bankAccount.branch'] = text(payload.branch, 120);
  if (payload.accountType !== undefined) patch['bankAccount.accountType'] = upper(payload.accountType, 10);
  if (payload.paymentReferencePrefix !== undefined) {
    patch['bankAccount.paymentReferencePrefix'] = upper(payload.paymentReferencePrefix, 20);
  }

  // The only place the real account number is ever touched: encrypt on the
  // way in, keep last-4 + a masked mirror for display. Never logged (§17).
  if (payload.accountNumber !== undefined && String(payload.accountNumber).trim() !== '') {
    const digits = digitsOnly(payload.accountNumber);
    patch['bankAccount.accountNumber'] = encryptSensitiveValue(digits);
    patch['bankAccount.accountNumberLast4'] = digits.slice(-4);
    patch['bankAccount.accountNumberMasked'] = maskAccountNumber(digits);
  }
  void current;
  return patch;
};

const PATCH_BUILDERS = {
  LEGAL: buildLegalPatch,
  STATUTORY: buildStatutoryPatch,
  POLICY: buildPolicyPatch,
  BANK: buildBankPatch,
};

// ── Update one section (§5/§22/§32) ────────────────────────────────────────

export const updatePayrollSetupSection = async ({
  companyId,
  section,
  payload = {},
  actor = null,
  req = null,
  expectedVersion = null,
  PayrollSetupModel = PayrollSetup,
  audit = writeAudit,
} = {}) => {
  const sectionKey = normalizeCode(section);
  if (!PAYROLL_SETUP_SECTION_KEYS.includes(sectionKey)) {
    throw ApiError.badRequest('Unknown payroll setup section');
  }

  const current = await PayrollSetupModel.findOne({ companyId, isCurrent: true });
  if (!current) throw ApiError.notFound('Payroll setup has not been started for this company');

  // Optimistic concurrency (§35): the client sends the version it loaded.
  if (expectedVersion !== null && expectedVersion !== undefined) {
    if (Number(expectedVersion) !== Number(current.configVersion)) {
      throw ApiError.conflict('This payroll setup was updated by someone else. Reload and try again.');
    }
  }

  const currentConfig = serializePayrollSetup(current);
  const patch = PATCH_BUILDERS[sectionKey](payload, currentConfig);

  // Draft/autosave semantics (§32): FORMAT errors are rejected, missing
  // required fields are allowed and reported as an incomplete section.
  const formatErrors = validateSectionFormat(sectionKey, payload, currentConfig);
  if (formatErrors.length > 0) {
    throw ApiError.badRequest('Please fix the highlighted fields', formatErrors);
  }

  // Merge in memory so the status/completeness can be computed BEFORE the
  // write — one atomic update, no read-modify-write race.
  const merged = applyPatchToConfig(currentConfig, sectionKey, patch, payload);
  const savedSections = Array.from(
    new Set([...(currentConfig.setup?.savedSections || []), sectionKey]),
  );
  const evaluation = evaluateConfiguration(merged, { savedSections });

  const patchKeys = Object.keys(patch);
  patch['setup.completedSections'] = evaluation.sections
    .filter((entry) => entry.complete)
    .map((entry) => entry.key);
  patch['setup.lastSavedAt'] = new Date();
  patch['updatedBy'] = actor?.id || null;

  // §4 — DRAFT/CONFIGURED follow completeness; ACTIVE/SUSPENDED are never
  // silently downgraded, an explicit suspend does that.
  if (['DRAFT', 'CONFIGURED'].includes(current.status)) {
    const nextStatus = evaluation.allComplete ? 'CONFIGURED' : 'DRAFT';
    if (nextStatus !== current.status) patch.status = nextStatus;
  }

  const updated = await PayrollSetupModel.findOneAndUpdate(
    { _id: current._id, companyId, configVersion: current.configVersion },
    {
      $set: patch,
      $addToSet: { 'setup.savedSections': sectionKey },
      $inc: { configVersion: 1 },
    },
    { new: true, runValidators: true, context: 'query' },
  );

  if (!updated) {
    throw ApiError.conflict('This payroll setup was updated by someone else. Reload and try again.');
  }

  await invalidatePayrollSetupCache(companyId);

  await audit({
    req,
    action: AUDIT_LABELS[sectionKey] || 'Payroll setup updated',
    companyId,
    actor,
    resourceId: updated._id,
    previousValue: sanitizeForAudit(sectionKey, sectionSnapshot(currentConfig, sectionKey)),
    newValue: sanitizeForAudit(sectionKey, sectionSnapshot(serializePayrollSetup(updated), sectionKey)),
    metadata: { section: sectionKey, fieldsChanged: patchKeys.length, status: updated.status },
  });

  const config = serializePayrollSetup(updated);
  return {
    config,
    evaluation: evaluateConfiguration(config, { savedSections: config.setup?.savedSections || [] }),
    summary: summarizePayrollSetup(config),
  };
};

const sectionSnapshot = (config, sectionKey) => {
  if (sectionKey === 'LEGAL') return config.legal;
  if (sectionKey === 'STATUTORY') return config.statutory;
  if (sectionKey === 'POLICY') return config.payrollPolicy;
  return config.bankAccount;
};

// Applies a dotted-path patch to the serialized config so completeness can
// be evaluated before the database write.
const applyPatchToConfig = (config, sectionKey, patch, payload) => {
  const next = JSON.parse(JSON.stringify(config));
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('.');
    let cursor = next;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor[parts[i]] = cursor[parts[i]] || {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }
  // The bank account number is intentionally not merged into the in-memory
  // copy: evaluation only needs "is a number stored / being stored".
  if (sectionKey === 'BANK' && String(payload?.accountNumber ?? '').trim() !== '') {
    next.bankAccount.accountNumberLast4 = digitsOnly(payload.accountNumber).slice(-4);
    next.bankAccount.accountNumber = undefined;
  }
  return next;
};

const validateSectionFormat = (sectionKey, payload, currentConfig = {}) => {
  if (sectionKey === 'LEGAL') return validateLegalSection({ ...currentConfig.legal, ...payload }, { partial: true });
  if (sectionKey === 'STATUTORY') {
    return validateStatutorySection(payload, { partial: true, pan: payload.pan ?? currentConfig.legal?.pan });
  }
  if (sectionKey === 'POLICY') return validatePolicySection(payload, { partial: true });
  return validateBankSection(payload, {
    partial: true,
    hasAccountNumber: Boolean(currentConfig.bankAccount?.accountNumberLast4),
  });
};

// ── Activate (§21) ─────────────────────────────────────────────────────────

export const activatePayrollSetup = async ({
  companyId,
  actor = null,
  req = null,
  expectedVersion = null,
  PayrollSetupModel = PayrollSetup,
  CompanyModel = Company,
  audit = writeAudit,
  notifier = notifyPayrollSetupActivated,
} = {}) => {
  const current = await PayrollSetupModel.findOne({ companyId, isCurrent: true });
  if (!current) throw ApiError.notFound('Payroll setup has not been started for this company');

  if (expectedVersion !== null && expectedVersion !== undefined) {
    if (Number(expectedVersion) !== Number(current.configVersion)) {
      throw ApiError.conflict('This payroll setup was updated by someone else. Reload and try again.');
    }
  }

  const config = serializePayrollSetup(current);
  const evaluation = evaluateConfiguration(config, {
    savedSections: config.setup?.savedSections || [],
  });

  // §21 — incomplete setup can never activate.
  if (!canActivate(evaluation)) {
    const missing = evaluation.sections.filter((entry) => !entry.complete).map((entry) => entry.label);
    throw ApiError.badRequest(
      `Payroll setup is incomplete. Pending: ${missing.join(', ')}`,
      evaluation.sections.flatMap((entry) => entry.errors),
    );
  }
  if (!ACTIVATABLE_STATUSES.includes(current.status)) {
    throw ApiError.conflict(`Payroll setup cannot be activated from ${current.status}`);
  }

  const now = new Date();
  const updated = await PayrollSetupModel.findOneAndUpdate(
    {
      _id: current._id,
      companyId,
      configVersion: current.configVersion,
      status: { $in: ACTIVATABLE_STATUSES },
    },
    {
      $set: {
        status: 'ACTIVE',
        'activation.activatedAt': now,
        'activation.activatedBy': actor?.id || null,
        'activation.suspendedAt': null,
        'activation.suspendedBy': null,
        'activation.suspendReason': '',
        updatedBy: actor?.id || null,
      },
      $inc: { configVersion: 1 },
    },
    { new: true, runValidators: true },
  );

  if (!updated) {
    throw ApiError.conflict('Payroll setup was changed by someone else. Reload and try again.');
  }

  await invalidatePayrollSetupCache(companyId);

  await audit({
    req,
    action: 'Payroll activated',
    companyId,
    actor,
    resourceId: updated._id,
    previousValue: { status: current.status, configVersion: current.configVersion },
    newValue: { status: 'ACTIVE', configVersion: current.configVersion + 1 },
    critical: true,
  });

  const company = await CompanyModel.findById(companyId).select('name').lean();
  await notifier({
    companyId,
    companyName: company?.name || 'your company',
    actorId: actor?.id || null,
  });

  const activatedConfig = serializePayrollSetup(updated);
  return {
    config: activatedConfig,
    evaluation: evaluateConfiguration(activatedConfig, {
      savedSections: activatedConfig.setup?.savedSections || [],
    }),
    summary: summarizePayrollSetup(activatedConfig),
  };
};

// ── Suspend (§22/§24) ──────────────────────────────────────────────────────

export const suspendPayrollSetup = async ({
  companyId,
  reason = '',
  actor = null,
  req = null,
  PayrollSetupModel = PayrollSetup,
  audit = writeAudit,
} = {}) => {
  const current = await PayrollSetupModel.findOne({ companyId, isCurrent: true });
  if (!current) throw ApiError.notFound('Payroll setup has not been started for this company');

  if (!canTransition(current.status, 'SUSPENDED')) {
    throw ApiError.conflict(`Payroll setup cannot be suspended from ${current.status}`);
  }

  const now = new Date();
  const updated = await PayrollSetupModel.findOneAndUpdate(
    { _id: current._id, companyId, status: current.status },
    {
      $set: {
        status: 'SUSPENDED',
        'activation.suspendedAt': now,
        'activation.suspendedBy': actor?.id || null,
        'activation.suspendReason': String(reason || '').trim().slice(0, 300),
        updatedBy: actor?.id || null,
      },
      $inc: { configVersion: 1 },
    },
    { new: true, runValidators: true },
  );

  if (!updated) {
    throw ApiError.conflict('Payroll setup was changed by someone else. Reload and try again.');
  }

  await invalidatePayrollSetupCache(companyId);

  await audit({
    req,
    action: 'Payroll suspended',
    companyId,
    actor,
    resourceId: updated._id,
    previousValue: { status: current.status },
    newValue: { status: 'SUSPENDED', reason: String(reason || '').trim().slice(0, 300) },
    critical: true,
  });

  const config = serializePayrollSetup(updated);
  return {
    config,
    evaluation: evaluateConfiguration(config),
    summary: summarizePayrollSetup(config),
  };
};
