// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.1 — AI USAGE TRACKER (tokens only — never text)
//
//  TWO JOBS, DELIBERATELY SEPARATE
//    1. recordUsage — append one AIUsageLog row. Fire-and-forget: a failure
//       to write the audit row must NEVER fail the AI response the person is
//       waiting for, and must never be retried into a duplicate.
//    2. checkQuota — read this tenant's token spend for the current calendar
//       month and answer allowed/refused. HARD, not soft (Phase 36 §5.6).
//
//  FAIL-CLOSED, NOT FAIL-OPEN
//    If the quota read cannot be completed, the call is REFUSED. Allowing the
//    request through would be a silent overage — the exact thing the quota
//    exists to prevent. A Mongo failure here means the API is already in
//    trouble, so refusing one AI call costs nothing.
// ═══════════════════════════════════════════════════════════════════════════

import AIUsageLog from '../../models/AIUsageLog.js';

import logger from '../../config/logger.js';

import { AI_ERROR_TYPES, AI_USAGE_STATUS } from './aiConfig.js';

import { AIError } from './aiErrors.js';

/** Calendar-month window in UTC. Documented: the quota is a calendar month. */
export const monthWindow = (now = new Date()) => {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );

  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );

  return { start, end };
};

const toSafeCount = (value) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) return 0;

  return Math.trunc(parsed);
};

/**
 * Append one usage row. Returns the promise so a caller MAY await it, but the
 * provider deliberately does not: it fires this and moves on.
 *
 * Never throws. Every failure path is swallowed after a metadata-only log —
 * there is nothing in this function worth a stack trace, and a logging
 * failure must not become an AI failure.
 */
export const recordUsage = async ({
  companyId,
  userId,
  feature,
  model = '',
  provider = 'groq',
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  latencyMs = 0,
  status = AI_USAGE_STATUS.SUCCESS,
  errorType = 'none',
  UsageModel = AIUsageLog,
} = {}) => {
  try {
    await UsageModel.create({
      companyId,
      userId,
      feature,
      provider,
      model,
      promptTokens: toSafeCount(promptTokens),
      completionTokens: toSafeCount(completionTokens),
      totalTokens: toSafeCount(totalTokens),
      latencyMs: toSafeCount(latencyMs),
      status,
      errorType: AI_ERROR_TYPES.includes(errorType) ? errorType : 'none',
    });

    return true;
  } catch (error) {
    // Metadata only: no ids beyond the tenant, no text, no vendor message.
    logger.warn('ai.usage.write_failed', {
      feature: String(feature || ''),
      status: String(status || ''),
      errorType: 'vendor',
    });

    return false;
  }
};

/**
 * Read this tenant's token spend for the current calendar month.
 *
 * Returns { allowed, used, limit, remaining, windowStart, windowEnd }.
 *
 * A limit of 0 or less means UNLIMITED (documented): a tenant with no
 * configured allowance must not be locked out by a zero nobody meant.
 *
 * Throws AIError.unavailable() when the read fails — fail closed, never open.
 */
export const checkQuota = async ({
  companyId,
  limitTokens,
  now = new Date(),
  UsageModel = AIUsageLog,
} = {}) => {
  const limit = Number(limitTokens);

  const window = monthWindow(now);

  // No configured allowance → nothing to enforce.
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      allowed: true,
      used: 0,
      limit: 0,
      remaining: Number.POSITIVE_INFINITY,
      windowStart: window.start,
      windowEnd: window.end,
    };
  }

  let used = 0;

  try {
    const rows = await UsageModel.aggregate([
      {
        $match: {
          companyId,
          createdAt: { $gte: window.start, $lt: window.end },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$totalTokens' },
        },
      },
    ]);

    used = toSafeCount(rows?.[0]?.total);
  } catch {
    // Fail CLOSED. A silent overage is worse than a refused AI call.
    throw AIError.unavailable();
  }

  return {
    allowed: used < limit,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    windowStart: window.start,
    windowEnd: window.end,
  };
};
