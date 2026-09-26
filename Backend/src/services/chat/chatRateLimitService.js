// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.11 — CHAT RATE LIMITS (REST + socket), ONE design
//
//  WHY A CHAT-SPECIFIC MODULE
//    The 32.4 store and the express middleware already exist and are reused
//    unchanged — no new packages, no second limiter implementation. What chat
//    needs on top of them is CHAT-SPECIFIC policy: which actions are limited,
//    how hard, and WHO the bucket belongs to.
//
//  IDENTITY (the part that must not be got wrong)
//    companyId + userId, both SERVER-DERIVED: for REST they come from
//    `req.companyId` / `req.user._id` after `protect` + `tenantMiddleware`;
//    for sockets they come from `socket.data`, written during the JWT
//    handshake. A client can never choose its own bucket by sending an id in
//    a payload (pinned by test/chatHardening.test.js).
//
//  MULTI-INSTANCE + DEGRADED BEHAVIOUR
//    Both surfaces ride utils/rateLimitStore.js, so the budget is ONE Redis
//    counter shared by API #1/#2/#N. When Redis is disabled, unreachable or
//    slower than 250 ms, the store degrades to its bounded per-process bucket
//    with the SAME refusal contract — a degraded deployment limits MORE
//    strictly per process, never unlimited. There is no fail-open path.
//
//  CHAT'S OWN BURST SHIELD
//    The 33.5 per-socket write guard (10 s / 30 writes, one connection) stays
//    where it is: it costs nothing, catches a runaway single client before a
//    Redis hop, and is not a substitute for these identity limits.
// ═══════════════════════════════════════════════════════════════════════════

import { securityRateLimit } from '../../middlewares/securityRateLimit.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';
import { logChatRateLimited } from '../../utils/chatObservability.js';

// ── POLICY ─────────────────────────────────────────────────────────────────
// Conservative defaults, chosen against real usage: reads are generous (a
// client legitimately refetches on every nudge), writes are strict, and the
// two EXPENSIVE operations — sending and uploading — are strictest because
// each one costs a Mongo write plus, for uploads, up to 10 MB of memory.
export const CHAT_REST_LIMITS = Object.freeze({
  'conversation.create': { windowMs: 10 * 60 * 1000, maximum: 10 },
  'conversation.list': { windowMs: 60 * 1000, maximum: 120 },
  'conversation.detail': { windowMs: 60 * 1000, maximum: 120 },
  'conversation.members.add': { windowMs: 10 * 60 * 1000, maximum: 20 },
  'conversation.members.remove': { windowMs: 10 * 60 * 1000, maximum: 20 },
  'message.history': { windowMs: 60 * 1000, maximum: 60 },
  'message.read': { windowMs: 60 * 1000, maximum: 120 },
  'message.moderateDelete': { windowMs: 60 * 1000, maximum: 30 },
  'attachment.upload': { windowMs: 10 * 60 * 1000, maximum: 20 },
  'attachment.download': { windowMs: 60 * 1000, maximum: 120 },
});

export const CHAT_SOCKET_LIMITS = Object.freeze({
  'socket.join': { event: 'chat:join', windowMs: 60 * 1000, maximum: 30 },
  'message.send': { event: 'chat:message:send', windowMs: 10 * 1000, maximum: 20 },
  'message.sendFile': { event: 'chat:message:sendFile', windowMs: 60 * 1000, maximum: 20 },
  'message.edit': { event: 'chat:message:edit', windowMs: 10 * 1000, maximum: 20 },
  'message.delete': { event: 'chat:message:delete', windowMs: 10 * 1000, maximum: 20 },
  'socket.readUpTo': { event: 'chat:readUpTo', windowMs: 10 * 1000, maximum: 60 },
});

const REST_MESSAGES = Object.freeze({
  'conversation.create': 'Too many conversations created. Please wait a few minutes.',
  'conversation.list': 'Too many chat requests. Please slow down.',
  'conversation.detail': 'Too many chat requests. Please slow down.',
  'conversation.members.add': 'Too many membership changes. Please wait a few minutes.',
  'conversation.members.remove': 'Too many membership changes. Please wait a few minutes.',
  'message.history': 'Too many history requests. Please slow down.',
  'message.read': 'Too many read updates. Please slow down.',
  'message.moderateDelete': 'Too many moderation actions. Please slow down.',
  'attachment.upload': 'Too many uploads. Please wait a few minutes.',
  'attachment.download': 'Too many downloads. Please slow down.',
});

// One namespace per action keeps budgets independent (a spammer exhausting
// sends must not lock the same user's reads).
const restFamily = (action) => `chat-${action.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

/**
 * The identity a REST bucket belongs to. Server-derived ONLY.
 */
export const chatRestIdentity = (req) =>
  `${String(req?.companyId ?? 'no-company')}:${String(req?.user?._id ?? req?.user?.id ?? 'no-user')}`;

/**
 * Build the express middleware for ONE chat action. Refusals are reported by
 * the action name; the count/maximum/window the middleware already logged via
 * headers are not re-derived here.
 */
export const chatRestRateLimit = (action) => {
  const policy = CHAT_REST_LIMITS[action];

  if (!policy) {
    throw new Error(`chatRestRateLimit: unknown action "${String(action)}"`);
  }

  return securityRateLimit({
    sharedName: restFamily(action),
    windowMs: policy.windowMs,
    maximum: policy.maximum,
    keyGenerator: chatRestIdentity,
    message: REST_MESSAGES[action] || 'Too many chat requests. Please slow down.',
    // Reported when the shared store refuses, so ops can separate real abuse
    // from a degraded (local-tier) deployment.
    onLimited: ({ req, tier, count }) =>
      logChatRateLimited({
        surface: 'rest',
        action,
        companyId: req?.companyId,
        userId: req?.user?._id ?? req?.user?.id,
        tier,
        count,
        maximum: policy.maximum,
        windowMs: policy.windowMs,
      }),
  });
};

// Pre-built middlewares — the routes import these, so an action can never be
// added to a route without a policy entry (chatRestRateLimit throws).
export const chatRestLimiters = Object.freeze(
  Object.fromEntries(
    Object.keys(CHAT_REST_LIMITS).map((action) => [
      action,
      chatRestRateLimit(action),
    ]),
  ),
);

// ── SOCKET ─────────────────────────────────────────────────────────────────

const socketFamily = (action) => `chat-socket-${action.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

/**
 * Identity-based socket limiter. Rides the SAME 32.4 store: shared bucket in
 * Redis across instances, bounded local bucket when Redis is degraded.
 *
 * `_storeFactory` is the hermetic-test seam. The returned function never
 * throws: a limiter failure must not take a listener down (33.9-fix law) —
 * an unexpected error is reported as a REFUSAL, because failing open on an
 * abuse control is the one outcome this module must never produce.
 */
export const createChatSocketRateLimiter = ({
  _storeFactory = createRateLimitStore,
  log = null,
} = {}) => {
  const stores = new Map();

  const storeFor = (action) => {
    let store = stores.get(action);

    if (!store) {
      store = _storeFactory({
        sharedName: socketFamily(action),
        windowMs: CHAT_SOCKET_LIMITS[action].windowMs,
      });

      stores.set(action, store);
    }

    return store;
  };

  return async ({ action, companyId, userId } = {}) => {
    const policy = CHAT_SOCKET_LIMITS[action];

    // Unknown action: not this module's business (callers pass literals).
    if (!policy) return { limited: false, tier: 'unchecked' };

    // Server-derived identity ONLY. Both values come from socket.data.
    const identity = `${String(companyId ?? 'no-company')}:${String(userId ?? 'no-user')}`;

    let result;

    try {
      result = await storeFor(action).hit(identity, policy.maximum);
    } catch {
      // The store is contractual-no-throw; if that ever changes, refuse.
      logChatRateLimited({
        surface: 'socket',
        action,
        companyId,
        userId,
        tier: 'local',
        count: policy.maximum + 1,
        maximum: policy.maximum,
        windowMs: policy.windowMs,
        log,
      });

      return { limited: true, tier: 'local', retryAfterMs: policy.windowMs };
    }

    if (result?.limited) {
      logChatRateLimited({
        surface: 'socket',
        action,
        companyId,
        userId,
        tier: result.tier,
        count: result.count,
        maximum: policy.maximum,
        windowMs: policy.windowMs,
        log,
      });

      return {
        limited: true,
        tier: result.tier,
        retryAfterMs: Math.max(0, Number(result.resetAt) - Date.now()),
      };
    }

    return { limited: false, tier: result?.tier ?? 'unknown' };
  };
};

/** ONE limiter instance for the process (per-action stores are lazy). */
export const chatSocketRateLimiter = createChatSocketRateLimiter();

/**
 * Stable refusal the socket layer sends. Same wording as the 33.5 burst
 * guard so a client cannot tell the two apart (no probing surface).
 */
export const CHAT_SOCKET_RATE_LIMITED_ACK = Object.freeze({
  code: 'RATE_LIMITED',
  message: 'Too many messages. Slow down and retry.',
});
