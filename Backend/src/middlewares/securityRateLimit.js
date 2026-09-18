import {
  createRateLimitStore,
} from '../utils/rateLimitStore.js';

// Phase 32.4 — pre-32.4 process-local buckets remain as the degraded
// mode fallback for every limiter (bounded, oldest-evicted by the
// store's shared fallback path; plain limiters keep their own map).
const buckets = new Map();

const defaultKey = (req) =>
  `${req.ip}:` +
  `${req.originalUrl}:` +
  `${String(
    req.body?.email || ''
  ).toLowerCase()}`;

// Phase 32.4 — optional SHARED tier. Passing `sharedName` makes the
// counter live in Redis (crewly:<env>:rl:<sharedName>:<identity>) so
// API #1/#2/#N enforce ONE budget; without it the limiter behaves
// exactly as before (process-local). The 429 contract and headers are
// identical in both tiers. Degraded Redis → in-process fallback.
export const securityRateLimit = ({
  windowMs = 60000,
  maximum = 10,
  keyGenerator = defaultKey,
  message =
    'Too many requests. Please try again later.',
  sharedName = null,
  store = null,
} = {}) => {
  const sharedStore =
    sharedName && !store
      ? createRateLimitStore({
          sharedName,
          windowMs,
        })
      : store;

  return async (req, res, next) => {
    const now = Date.now();
    const key =
      keyGenerator(req);

    if (sharedStore) {
      const result = await sharedStore.hit(key, maximum);

      res.setHeader(
        'X-RateLimit-Limit',
        maximum
      );

      res.setHeader(
        'X-RateLimit-Remaining',
        result.remaining
      );

      res.setHeader(
        'X-RateLimit-Reset',
        Math.ceil(
          result.resetAt / 1000
        )
      );

      if (result.limited) {
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

      return next();
    }

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