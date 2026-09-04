// ============================================================
//  PHASE 30.1 — BGV CHECK FRAMEWORK · PURE RULES
//
// 100% pure: no Mongo, no I/O, no Redis. Every rule the
// Verifier Workbench depends on lives here so it can be unit
// tested hermetically. The service layer (bgvCheckService.js)
// is the only consumer; sub-phases 30.2-30.6 reuse these
// primitives for their own check-type logic.
// ============================================================

export const BGV_CHECK_TYPES = Object.freeze([
  'IDENTITY',
  'ADDRESS',
  'EDUCATION',
  'EMPLOYMENT',
  'COURT_RECORD',
]);

export const BGV_CHECK_STATUSES = Object.freeze([
  'PENDING',
  'IN_PROGRESS',
  'VERIFIED',
  'DISCREPANCY',
  'UTV',
  'INSUFFICIENT_DATA',
  'SKIPPED',
]);

// VERIFIED / UTV / SKIPPED are terminal (reopen only via the
// dedicated, permission-gated reopen action). DISCREPANCY is
// deliberately NOT terminal: it stays on the verifier's board
// until a human resolves it.
export const BGV_CHECK_TERMINAL_STATUSES = Object.freeze([
  'VERIFIED',
  'UTV',
  'SKIPPED',
]);

export const BGV_EVIDENCE_KINDS = Object.freeze([
  'SCREENSHOT',
  'DOCUMENT',
  'NOTE',
  'CALL_LOG',
  'LINK',
  'VIDEO_KYC_NOTE',
  'FIELD_VISIT',
]);

export const BGV_EVIDENCE_FILE_KINDS = Object.freeze(['SCREENSHOT', 'DOCUMENT']);

// Evidence file types accepted in 30.1 (screenshots + PDFs).
export const BGV_EVIDENCE_MIME_ALLOWLIST = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);

export const DEFAULT_BGV_SLA_DAYS = 10;
export const MIN_BGV_SLA_DAYS = 1;
export const MAX_BGV_SLA_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

const cleanStr = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const boundedInt = (value, min, max, fallback) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

// ── SLA ──────────────────────────────────────────────────────────
// Per-type SLA days come from the company BGV settings snapshot;
// missing entries fall back to 10 days (business default).
export const slaDaysForType = (settings, checkType) => {
  const configured = settings?.checkConfig?.[checkType]?.slaDays;
  return boundedInt(configured, MIN_BGV_SLA_DAYS, MAX_BGV_SLA_DAYS, DEFAULT_BGV_SLA_DAYS);
};

export const computeSlaDueAt = (settings, checkType, initiatedAt) => {
  const start = initiatedAt instanceof Date ? initiatedAt : new Date(initiatedAt || Date.now());
  const base = Number.isNaN(start.getTime()) ? new Date() : start;
  return new Date(base.getTime() + slaDaysForType(settings, checkType) * DAY_MS);
};

// Which BgvCheck rows a case should carry. A type is created only
// when the settings snapshot has not marked it not-required
// (missing config = required, matching 27.15 "all checks on"
// defaults).
export const requiredCheckTypesForSettings = (settings) =>
  BGV_CHECK_TYPES.map((checkType) => {
    const entry = settings?.checkConfig?.[checkType];
    return {
      checkType,
      required: entry?.required !== false,
      slaDays: slaDaysForType(settings, checkType),
    };
  });

// ── Status machine ───────────────────────────────────────────────
const OPEN_TRANSITIONS = Object.freeze({
  PENDING: ['IN_PROGRESS', 'SKIPPED'],
  IN_PROGRESS: ['VERIFIED', 'DISCREPANCY', 'UTV', 'INSUFFICIENT_DATA'],
  INSUFFICIENT_DATA: ['IN_PROGRESS'],
  DISCREPANCY: ['VERIFIED', 'IN_PROGRESS'],
});

// context: { isRequired, resultSummary, discrepancyNote, closedReason,
//            reason, canReopen }
export const isValidTransition = (fromStatus, toStatus, context = {}) => {
  const fail = (reason) => ({ ok: false, reason });
  if (!BGV_CHECK_STATUSES.includes(fromStatus) || !BGV_CHECK_STATUSES.includes(toStatus)) {
    return fail('Unknown BGV check status');
  }
  if (fromStatus === toStatus) return fail('Status is already ' + toStatus);

  if (BGV_CHECK_TERMINAL_STATUSES.includes(fromStatus)) {
    if (toStatus === 'IN_PROGRESS' && context.canReopen) {
      if (!cleanStr(context.reason, 500)) return fail('Reopen requires a written reason');
      return { ok: true };
    }
    return fail('Terminal check — use the reopen action (requires reopen permission and a reason)');
  }

  if (!OPEN_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    return fail(`Cannot move ${fromStatus} to ${toStatus}`);
  }

  // Guard clauses (spec: store evidence, require justification).
  if (toStatus === 'SKIPPED' && context.isRequired) {
    return fail('Required checks cannot be skipped');
  }
  if (toStatus === 'VERIFIED' && !cleanStr(context.resultSummary, 2000)) {
    return fail('A result summary is required to verify');
  }
  if (toStatus === 'DISCREPANCY' && !cleanStr(context.discrepancyNote, 2000)) {
    return fail('A discrepancy note is required');
  }
  if (toStatus === 'UTV' && !cleanStr(context.closedReason, 200)) {
    return fail('A closure reason is required for Unable to Verify');
  }
  if (fromStatus === 'DISCREPANCY' && toStatus === 'IN_PROGRESS' && !cleanStr(context.reason, 500)) {
    return fail('Reopening from DISCREPANCY requires a reason');
  }
  return { ok: true };
};

// Check-level status derived from its entries (multi-entry checks:
// two employers, two degrees, ...). "any worse beats all better",
// never a rejection, only a review state.
export const rollupCheckStatusFromEntries = (entries = []) => {
  const statuses = entries.map((entry) => entry?.status);
  if (!statuses.length) return 'PENDING';
  if (statuses.includes('DISCREPANCY')) return 'DISCREPANCY';
  if (statuses.includes('UTV')) return 'UTV';
  if (statuses.includes('INSUFFICIENT_DATA')) return 'INSUFFICIENT_DATA';
  const allSettled = statuses.every((s) => s === 'VERIFIED' || s === 'SKIPPED');
  if (allSettled && statuses.includes('VERIFIED')) return 'VERIFIED';
  const untouched = statuses.every((s) => s === 'PENDING');
  return untouched ? 'PENDING' : 'IN_PROGRESS';
};

// ── Evidence meta (allowlisted per kind — everything else dropped) ──
const numberOr = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const sanitizeEvidenceMeta = (kind, rawMeta) => {
  const meta = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) ? rawMeta : {};
  if (kind === 'CALL_LOG') {
    return {
      phone: cleanStr(meta.phone, 24),
      durationSec: boundedInt(meta.durationSec, 0, 86400, 0),
      outcome: cleanStr(meta.outcome, 200),
    };
  }
  if (kind === 'FIELD_VISIT') {
    // Full precision is kept for the verifier view; audit rows get
    // reduced precision (see rules below).
    return {
      geoLat: numberOr(meta.geoLat),
      geoLng: numberOr(meta.geoLng),
      geoAccuracyM: boundedInt(meta.geoAccuracyM, 0, 100000, 0),
    };
  }
  if (kind === 'LINK') {
    const url = cleanStr(meta.url, 500);
    return { url: /^https?:\/\//i.test(url) ? url : '' };
  }
  return {};
};

export const maskPhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return 'XXXX-XXXX-' + digits.slice(-4);
};

export const roundGeoForAudit = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(3)) : null;
};

// 30.1 must never receive raw identity document numbers (they
// arrive in 30.2 behind encryption + masking). Patterns: Aadhaar-
// style 12-digit groups, PAN, passport numbers. Verifiers write
// masked values instead (XXXX XXXX 9012).
const RAW_DOCUMENT_PATTERNS = [
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/,
  /\b[EPep]\d{7}[A-Za-z]{0,2}\b/,
];

export const containsRawDocumentNumber = (value) => {
  if (value === null || value === undefined) return false;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return false;
  }
  return RAW_DOCUMENT_PATTERNS.some((pattern) => pattern.test(text));
};

// ── Workbench aging buckets (days since the check was initiated) ──
export const AGING_BUCKETS = Object.freeze(['0-3', '4-7', '8-12', '>12']);

export const agingBucketBounds = (bucket, now = new Date()) => {
  const range = { '0-3': [0, 3], '4-7': [4, 7], '8-12': [8, 12], '>12': [13, null] }[bucket];
  if (!range) return null;
  const [minDays, maxDays] = range;
  const bounds = {};
  if (maxDays !== null) bounds.$gte = new Date(now.getTime() - (maxDays + 1) * DAY_MS);
  bounds.$lte = new Date(now.getTime() - minDays * DAY_MS);
  return bounds;
};
