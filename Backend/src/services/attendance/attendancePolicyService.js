// ─────────────────────────────────────────────────────────────
// Phase 31.1 — attendance policy service (thin orchestration).
//
// All business rules live in attendancePolicyRules.js (pure). This
// module only wires Mongo + cache + audit with injected seams so the
// hermetic suite never touches a live database or Redis.
//
// Lifecycle: POST /draft upserts the single DRAFT (prefilled from the
// ACTIVE policy when one exists); POST /activate archives the current
// ACTIVE row and promotes the DRAFT. History rows are never mutated.
// ─────────────────────────────────────────────────────────────
import AttendancePolicy from '../../models/AttendancePolicy.js';
import Company from '../../models/Company.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../config/logger.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
} from '../../services/redisCacheService.js';
import {
  canTransitionPolicy,
  defaultPolicyInput,
  validatePolicy,
} from './attendancePolicyRules.js';

export const CACHE_NAMESPACE = 'attendance-policy';
export const CACHE_VERSION = 1;

const MIN_TTL_SECONDS = 10;
const MAX_TTL_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 300;

export const getPolicyCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.ATTENDANCE_POLICY_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, parsed));
};

export const buildAttendancePolicyCacheKey = (companyId) =>
  buildTenantCacheKey({
    companyId,
    namespace: CACHE_NAMESPACE,
    version: CACHE_VERSION,
    segments: ['current'],
  });

export const invalidateAttendancePolicyCache = async (companyId) => {
  const key = buildAttendancePolicyCacheKey(companyId);
  if (!key) return false;

  try {
    return Boolean(await deleteCache(key));
  } catch {
    logger.debug('[AttendancePolicy] cache invalidate no-op (Redis unavailable or key absent)');
    return false;
  }
};

export const serializeAttendancePolicy = (doc) => {
  if (!doc) return null;

  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;

  return {
    id: String(raw._id || raw.id || ''),
    companyId: String(raw.companyId || ''),
    name: raw.name || '',
    description: raw.description || '',
    timezone: raw.timezone || 'Asia/Kolkata',
    status: raw.status || 'DRAFT',
    version: Number(raw.version || 0),
    configVersion: Number(raw.configVersion || 1),
    isCurrent: Boolean(raw.isCurrent),
    effectiveFrom: raw.effectiveFrom || null,
    effectiveTo: raw.effectiveTo || null,
    thresholds: raw.thresholds || {},
    grace: raw.grace || {},
    breaks: raw.breaks || {},
    missingPunch: raw.missingPunch || {},
    overtime: raw.overtime || {},
    weekendHoliday: raw.weekendHoliday || {},
    workModes: raw.workModes || {},
    locationEnforcement: raw.locationEnforcement || 'DISABLED',
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    activatedAt: raw.activatedAt || null,
  };
};

const writeAudit = (args) => recordAudit(args);

const summarizePolicy = (policy) => ({
  name: policy?.name || '',
  status: policy?.status || '',
  version: Number(policy?.version || 0),
  configVersion: Number(policy?.configVersion || 0),
  thresholds: policy?.thresholds || {},
  grace: policy?.grace || {},
  overtimeTracking: Boolean(policy?.overtime?.trackingEnabled),
  locationEnforcement: policy?.locationEnforcement || 'DISABLED',
});

// ── Read current ─────────────────────────────────────────────

export const getCurrentPolicy = async ({
  companyId,
  io,
  AttendancePolicyModel = AttendancePolicy,
} = {}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');

  const loader = async () => {
    const current = await AttendancePolicyModel.findOne({ companyId, isCurrent: true }).lean();
    const draft = current
      ? null
      : await AttendancePolicyModel.findOne({ companyId, status: 'DRAFT' }).lean();

    return {
      policy: serializeAttendancePolicy(current || draft),
      configured: Boolean(current || draft),
      hasActive: Boolean(current),
    };
  };

  const key = buildAttendancePolicyCacheKey(companyId);

  if (!key) {
    return { ...(await loader()), cache: 'BYPASS' };
  }

  const { value, cache } = await getOrSetCache(key, {
    ttlSeconds: getPolicyCacheTtlSeconds(),
    version: CACHE_VERSION,
    loader,
    io,
  });

  return { ...value, cache };
};

// ── History (audit/reference — always Mongo, never cached) ───

export const listPolicyHistory = async ({
  companyId,
  limit = 20,
  AttendancePolicyModel = AttendancePolicy,
} = {}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');

  const bounded = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)));

  const rows = await AttendancePolicyModel.find({ companyId })
    .sort({ version: -1, updatedAt: -1 })
    .limit(bounded)
    .lean();

  return { history: (rows || []).map(serializeAttendancePolicy) };
};

// ── Draft (create/update the single DRAFT) ───────────────────

const ALLOWED_DRAFT_FIELDS = [
  'name',
  'description',
  'timezone',
  'thresholds',
  'grace',
  'breaks',
  'missingPunch',
  'overtime',
  'weekendHoliday',
  'workModes',
  'locationEnforcement',
];

const pickDraftFields = (input = {}) =>
  Object.fromEntries(
    ALLOWED_DRAFT_FIELDS.filter((field) => input[field] !== undefined).map((field) => [
      field,
      input[field],
    ]),
  );

export const saveDraftPolicy = async ({
  companyId,
  input = {},
  actor = null,
  req = null,
  expectedConfigVersion = null,
  AttendancePolicyModel = AttendancePolicy,
  CompanyModel = Company,
  audit = writeAudit,
} = {}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');

  const patch = pickDraftFields(input);
  const existing = await AttendancePolicyModel.findOne({ companyId, status: 'DRAFT' });

  if (existing && expectedConfigVersion !== null && expectedConfigVersion !== undefined) {
    if (Number(expectedConfigVersion) !== Number(existing.configVersion)) {
      throw ApiError.conflict('This attendance policy was updated by someone else. Reload and try again.');
    }
  }

  // New drafts prefill from the ACTIVE policy so HR edits today's rules
  // instead of blank defaults; a first-ever draft falls back to the
  // canonical defaults. Timezone falls back to the company's.
  let base = null;

  if (!existing) {
    const active = await AttendancePolicyModel.findOne({ companyId, isCurrent: true }).lean();
    const company = CompanyModel ? await CompanyModel.findById(companyId).select('timezone').lean() : null;

    base = {
      ...defaultPolicyInput(),
      ...(active ? serializeAttendancePolicy(active) : {}),
      timezone: company?.timezone || active?.timezone || 'Asia/Kolkata',
    };

    delete base.id;
    delete base.companyId;
  }

  const merged = { ...(base || {}), ...(existing ? serializeAttendancePolicy(existing) : {}), ...patch };
  const check = validatePolicy({
    name: merged.name || 'Attendance Policy',
    timezone: merged.timezone,
    locationEnforcement: merged.locationEnforcement,
    thresholds: merged.thresholds,
    grace: merged.grace,
    breaks: merged.breaks,
    missingPunch: merged.missingPunch,
    overtime: merged.overtime,
    weekendHoliday: merged.weekendHoliday,
    workModes: merged.workModes,
  });

  if (!check.valid) {
    throw ApiError.badRequest(`Attendance policy is invalid: ${check.errors.join('; ')}`);
  }

  let saved;
  let created;

  if (existing) {
    Object.assign(existing, patch, {
      name: patch.name ?? existing.name,
      configVersion: Number(existing.configVersion || 1) + 1,
      updatedBy: actor?._id || actor?.id || null,
    });
    saved = await existing.save();
    created = false;
  } else {
    saved = await AttendancePolicyModel.create({
      companyId,
      name: merged.name || 'Attendance Policy',
      description: merged.description || '',
      timezone: merged.timezone,
      status: 'DRAFT',
      version: 0,
      configVersion: 1,
      isCurrent: false,
      thresholds: merged.thresholds,
      grace: merged.grace,
      breaks: merged.breaks,
      missingPunch: merged.missingPunch,
      overtime: merged.overtime,
      weekendHoliday: merged.weekendHoliday,
      workModes: merged.workModes,
      locationEnforcement: merged.locationEnforcement || 'DISABLED',
      createdBy: actor?._id || actor?.id || null,
      updatedBy: actor?._id || actor?.id || null,
    });
    created = true;
  }

  await invalidateAttendancePolicyCache(companyId);

  await audit({
    req,
    action: created ? 'ATTENDANCE_POLICY_CREATED' : 'ATTENDANCE_POLICY_UPDATED',
    companyId,
    actorId: actor?._id || actor?.id || null,
    resource: 'AttendancePolicy',
    resourceId: saved._id,
    newValue: summarizePolicy(serializeAttendancePolicy(saved)),
  }).catch(() => {});

  return { policy: serializeAttendancePolicy(saved), created };
};

// ── Activate (DRAFT → ACTIVE; archive the previous ACTIVE) ───

export const activatePolicy = async ({
  companyId,
  actor = null,
  req = null,
  expectedConfigVersion = null,
  AttendancePolicyModel = AttendancePolicy,
  audit = writeAudit,
} = {}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');

  const draft = await AttendancePolicyModel.findOne({ companyId, status: 'DRAFT' });

  if (!draft) {
    throw ApiError.badRequest('No draft attendance policy to activate');
  }

  if (!canTransitionPolicy(draft.status, 'ACTIVE')) {
    throw ApiError.conflict(`Attendance policy cannot be activated from ${draft.status}`);
  }

  if (expectedConfigVersion !== null && expectedConfigVersion !== undefined) {
    if (Number(expectedConfigVersion) !== Number(draft.configVersion)) {
      throw ApiError.conflict('This attendance policy was updated by someone else. Reload and try again.');
    }
  }

  const check = validatePolicy(serializeAttendancePolicy(draft));

  if (!check.valid) {
    throw ApiError.badRequest(`Draft attendance policy is invalid: ${check.errors.join('; ')}`);
  }

  const current = await AttendancePolicyModel.findOne({ companyId, isCurrent: true });
  const now = new Date();
  const previousSummary = current ? summarizePolicy(serializeAttendancePolicy(current)) : null;

  if (current) {
    current.status = 'ARCHIVED';
    current.isCurrent = false;
    current.effectiveTo = now;
    await current.save();
  }

  draft.status = 'ACTIVE';
  draft.isCurrent = true;
  draft.version = Number(current?.version || 0) + 1;
  draft.configVersion = Number(draft.configVersion || 1) + 1;
  draft.effectiveFrom = now;
  draft.effectiveTo = null;
  draft.activatedBy = actor?._id || actor?.id || null;
  draft.activatedAt = now;
  draft.updatedBy = actor?._id || actor?.id || null;

  const saved = await draft.save();

  await invalidateAttendancePolicyCache(companyId);

  await audit({
    req,
    action: 'ATTENDANCE_POLICY_ACTIVATED',
    companyId,
    actorId: actor?._id || actor?.id || null,
    resource: 'AttendancePolicy',
    resourceId: saved._id,
    previousValue: previousSummary,
    newValue: summarizePolicy(serializeAttendancePolicy(saved)),
    critical: true,
  }).catch(() => {});

  return { policy: serializeAttendancePolicy(saved) };
};
