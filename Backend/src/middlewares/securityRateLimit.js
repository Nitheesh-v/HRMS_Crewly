const buckets = new Map();

const defaultKey = (req) =>
  `${req.ip}:` +
  `${req.originalUrl}:` +
  `${String(
    req.body?.email || ''
  ).toLowerCase()}`;

export const securityRateLimit = ({
  windowMs = 60000,
  maximum = 10,
  keyGenerator = defaultKey,
  message =
    'Too many requests. Please try again later.',
} = {}) =>
  (req, res, next) => {
    const now = Date.now();
    const key =
      keyGenerator(req);

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

export const loginRateLimit =
  securityRateLimit({
    windowMs: 60000,
    maximum: 5,

    message:
      'Too many login attempts. Please wait one minute.',
  });

export const resetRateLimit =
  securityRateLimit({
    windowMs:
      15 * 60 * 1000,

    maximum: 5,

    message:
      'Too many password reset requests. Please try again later.',
  });

export const refreshRateLimit =
  securityRateLimit({
    windowMs: 60000,
    maximum: 30,

    keyGenerator: (req) =>
      `${req.ip}:refresh`,

    message:
      'Too many token refresh requests.',
  });

export const passwordChangeRateLimit =
  securityRateLimit({
    windowMs:
      15 * 60 * 1000,

    maximum: 5,

    keyGenerator: (req) =>
      `${req.ip}:` +
      `${req.user?._id}:` +
      `password-change`,
  });