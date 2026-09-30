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
/**
 * Phase 36.6 — the admin usage breakdown.
 *
 * WHAT THIS IS FOR. A company admin needs to answer "where did this
 * month's AI budget go?" before it is gone, not after. Two questions,
 * two aggregations:
 *
 *   1. byFeature — which surface spent the tokens
 *   2. topUsers   — which five people spent the most
 *
 * THE PRIVACY LINE, DRAWN DELIBERATELY.
 *
 * `topUsers` returns a name, a designation and a TOKEN COUNT. It returns
 * no prompt, no reply, no category list and no timestamp per user. A
 * company admin can already see every employee's name and designation on
 * the employee screen, so this exposes nothing new about WHO — only
 * how many tokens they spent, which is the number the quota is made of.
 *
 * It is strictly scoped to `companyId` (server-derived, never supplied by
 * the client) and the route is behind SETTINGS_MANAGE. There is no
 * cross-tenant read here: the $match is the only thing that decides whose
 * rows come back.
 *
 * WHY THIS IS NOT `getMonthUsage`. That function answers "may this
 * request proceed?" and is on the hot path, so it fails CLOSED. This one
 * answers "show me a dashboard" and is not on any hot path, so it fails
 * SAFE — an empty dashboard is a degraded page, not a refused AI call.
 * Mixing the two failure modes into one function would make both wrong.
 *
 * @param {object}   options
 * @param {string}   options.companyId
 * @param {Date}     [options.now]
 * @param {object}   [options.UsageModel]
 * @param {number}   [options.topUserLimit]
 */
export const getUsageBreakdown = async ({
  companyId,
  now = new Date(),
  UsageModel = AIUsageLog,
  topUserLimit = 5,
} = {}) => {
  const window = monthWindow(now);

  const empty = {
    byFeature: [],
    byStatus: {},
    topUsers: [],
    totalTokens: 0,
    calls: 0,
    windowStart: window.start,
    windowEnd: window.end,
  };

  try {
    const match = {
      companyId,
      createdAt: { $gte: window.start, $lt: window.end },
    };

    const [featureRows, statusRows, userRows] = await Promise.all([
      UsageModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$feature',
            totalTokens: { $sum: '$totalTokens' },
            calls: { $sum: 1 },
          },
        },
        { $sort: { totalTokens: -1 } },
      ]),

      UsageModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$status',
            totalTokens: { $sum: '$totalTokens' },
            calls: { $sum: 1 },
          },
        },
      ]),

      // The join is READ-ONLY and narrow: two scalar fields off User, and
      // only for the top N. `preserveNullAndEmptyArrays` matters — a
      // deleted user must not silently drop a real token spend off the
      // dashboard, so the row survives with an empty name.
      UsageModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$userId',
            totalTokens: { $sum: '$totalTokens' },
            calls: { $sum: 1 },
          },
        },
        { $sort: { totalTokens: -1 } },
        { $limit: Math.max(1, Math.trunc(topUserLimit)) },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'person',
          },
        },
        { $unwind: { path: '$person', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            totalTokens: 1,
            calls: 1,
            name: { $ifNull: ['$person.name', ''] },
            designation: { $ifNull: ['$person.designation', ''] },
          },
        },
      ]),
    ]);

    let totalTokens = 0;

    let calls = 0;

    const byStatus = {};

    (statusRows || []).forEach((row) => {
      const tokens = toSafeCount(row?.totalTokens);

      const count = toSafeCount(row?.calls);

      totalTokens += tokens;

      calls += count;

      byStatus[String(row?._id || 'UNKNOWN')] = {
        totalTokens: tokens,
        calls: count,
      };
    });

    return {
      byFeature: (featureRows || []).map((row) => ({
        feature: String(row?._id || 'UNKNOWN'),
        totalTokens: toSafeCount(row?.totalTokens),
        calls: toSafeCount(row?.calls),
      })),

      byStatus,

      topUsers: (userRows || []).map((row) => ({
        userId: String(row?._id || ''),
        name: String(row?.name || ''),
        designation: String(row?.designation || ''),
        totalTokens: toSafeCount(row?.totalTokens),
        calls: toSafeCount(row?.calls),
      })),

      totalTokens,
      calls,
      windowStart: window.start,
      windowEnd: window.end,
    };
  } catch (error) {
    logger.warn('ai.usage.breakdown_failed', {
      errorCode: String(error?.code || error?.name || 'error'),
    });

    return empty;
  }
};

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

/**
 * Phase 36.2 — this tenant's spend for the current calendar month, for the
 * admin config screen.
 *
 * NEW function: nothing above changed. The admin needs to see what the quota
 * is being measured against, and the only honest source is the same rows
 * checkQuota sums. Deliberately returns ZEROS rather than throwing when the
 * read fails — this is a DISPLAY number, and a broken dashboard must not turn
 * into a broken AI call the way a broken quota read must.
 *
 * Metadata only: counts and the window. No feature names, no rows, no text.
 */
export const getMonthUsage = async ({
  companyId,
  now = new Date(),
  UsageModel = AIUsageLog,
} = {}) => {
  const window = monthWindow(now);

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
          _id: '$status',
          totalTokens: { $sum: '$totalTokens' },
          calls: { $sum: 1 },
        },
      },
    ]);

    let totalTokens = 0;

    let calls = 0;

    const byStatus = {};

    (rows || []).forEach((row) => {
      const tokens = toSafeCount(row?.totalTokens);

      const count = toSafeCount(row?.calls);

      totalTokens += tokens;

      calls += count;

      byStatus[String(row?._id || 'UNKNOWN')] = { totalTokens: tokens, calls: count };
    });

    return {
      totalTokens,
      calls,
      byStatus,
      windowStart: window.start,
      windowEnd: window.end,
    };
  } catch (error) {
    logger.warn('ai.usage.read_failed', {
      errorCode: String(error?.code || error?.name || 'error'),
    });

    return {
      totalTokens: 0,
      calls: 0,
      byStatus: {},
      windowStart: window.start,
      windowEnd: window.end,
    };
  }
};
