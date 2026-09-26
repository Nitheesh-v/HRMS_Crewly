import { createRateLimitStore } from '../utils/rateLimitStore.js';

import { hashToken } from '../utils/securityPolicy.js';

// Phase 32.4 — pre-32.4 process-local buckets remain as the degraded
// mode for every limiter (Redis is coordination, never truth).
const buckets = new Map();

// Phase 32.4 (§13) — personal dimensions (email) are NEVER placed in
// limiter keys raw. A normalized one-way digest keeps buckets
// per-account without leaking PII into Redis/ops visibility. Hashing
// low-entropy data is not encryption — this prevents accidental raw
// exposure, not guessing.
const emailFingerprint = (email) =>
  hashToken(String(email || '').trim().toLowerCase()).slice(0, 16);

const defaultKey = (req) =>
  `${req.ip}:` +
  `${req.originalUrl}:` +
  `${emailFingerprint(req.body?.email)}`;

export const securityRateLimit = ({
  windowMs = 60000,
  maximum = 10,
  keyGenerator = defaultKey,
  message =
    'Too many requests. Please try again later.',
  sharedName = null,
  store = null,
  // 33.11 — OPTIONAL reporting hook, additive and never breaking: called
  // exactly once when a request is refused, with the tier that refused it
  // ('shared' = the Redis budget, 'local' = the degraded per-process
  // bucket). Observability must never change the answer, so a hook that
  // throws is swallowed. Existing callers pass nothing and are unaffected.
  onLimited = null,
} = {}) => {
  // Phase 32.4 — optional SHARED tier: one budget in Redis across API
  // #1/#2/#N under crewly:<env>:rl:<sharedName>:<identity>. Without
  // sharedName the limiter behaves exactly as before (process-local).
  const sharedStore =
    sharedName && !store
      ? createRateLimitStore({ sharedName, windowMs })
      : store;

  return async (req, res, next) => {
    const key = keyGenerator(req);

    if (sharedStore) {
      let result = null;

      try {
        result = await sharedStore.hit(key, maximum);
      } catch {
        result = null; // unreachable by contract; local path below
      }

      if (result) {
        res.setHeader('X-RateLimit-Limit', maximum);

        res.setHeader(
          'X-RateLimit-Remaining',
          result.remaining
        );

        res.setHeader(
          'X-RateLimit-Reset',
          Math.ceil(result.resetAt / 1000)
        );

        if (result.limited) {
          // Exact, TTL-derived retry hint (shared tier only).
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((result.resetAt - Date.now()) / 1000)
          );

          try {
            onLimited?.({
              req,
              tier: result.tier || 'shared',
              count: result.count,
              remaining: result.remaining,
              retryAfterSeconds,
            });
          } catch {
            /* observability must never change the response */
          }

          res.setHeader('Retry-After', retryAfterSeconds);

          return res.status(429).json({
            statusCode: 429,
            success: false,
            code: 'RATE_LIMITED',
            message,
          });
        }

        return next();
      }
    }

    const now = Date.now();

    const bucket =
      buckets.get(key) || {
        count: 0,
        resetAt:
          now + windowMs,
      };

    if (
      bucket.resetAt <= now
    ) {
      bucket.count = 0;
      bucket.resetAt =
        now + windowMs;
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    res.setHeader(
      'X-RateLimit-Limit',
      maximum
    );

    res.setHeader(
      'X-RateLimit-Remaining',
      Math.max(
        0,
        maximum -
          bucket.count
      )
    );

    res.setHeader(
      'X-RateLimit-Reset',
      Math.ceil(
        bucket.resetAt / 1000
      )
    );

    if (
      bucket.count >
      maximum
    ) {
      try {
        onLimited?.({
          req,
          tier: 'local',
          count: bucket.count,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((bucket.resetAt - Date.now()) / 1000)
          ),
        });
      } catch {
        /* observability must never change the response */
      }

      return res
        .status(429)
        .json({
          statusCode: 429,
          success: false,
          code:
            'RATE_LIMITED',
          message,
        });
    }

    next();
  };
};

export const loginRateLimit =
  securityRateLimit({
    sharedName: 'login',
    windowMs: 60000,
    maximum: 5,

    message:
      'Too many login attempts. Please wait one minute.',
  });

export const resetRateLimit =
  securityRateLimit({
    sharedName: 'password-reset',
    windowMs:
      15 * 60 * 1000,

    maximum: 5,

    message:
      'Too many password reset requests. Please try again later.',
  });

export const refreshRateLimit =
  securityRateLimit({
    sharedName: 'refresh',
    windowMs: 60000,
    maximum: 30,

    keyGenerator: (req) =>
      `${req.ip}:refresh`,

    message:
      'Too many token refresh requests.',
  });

export const passwordChangeRateLimit =
  securityRateLimit({
    sharedName: 'password-change',
    windowMs:
      15 * 60 * 1000,

    maximum: 5,

    keyGenerator: (req) =>
      `${req.ip}:` +
      `${req.user?._id}:` +
      `password-change`,
  });