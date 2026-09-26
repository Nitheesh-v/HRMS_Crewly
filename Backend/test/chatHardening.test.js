// ============================================================
//  PHASE 33.11 — CHAT HARDENING (HERMETIC).
//
//  No Redis, no Mongo, no HTTP server: the REAL shipped limiter stack runs
//  against injected stores and fakes —
//    · middleware/securityRateLimit.js (the repo's express limiter)
//    · utils/rateLimitStore.js          (the 32.4 distributed store)
//    · services/chat/chatRateLimitService.js (33.11 chat policy)
//
//  PINNED BEHAVIOUR
//    · REST: a chat action refuses with 429 + the repo's error shape after
//      its threshold, and the budget is PER TENANT+USER — company A's traffic
//      never consumes company B's bucket, and neither does another user's.
//    · Socket: an event refuses with the stable RATE_LIMITED ACK after its
//      threshold, and the identity comes from socket.data — a payload that
//      claims another company/user cannot move the bucket (no client-chosen
//      limits, no cross-tenant starvation).
//    · Degraded: with Redis DISABLED (strict parser) the store reports the
//      LOCAL tier and STILL refuses — degradation is never unlimited.
//    · Redis dead/slow: the store's circuit falls back to the bounded local
//      bucket with the same contract (never fail-open), and the limiter
//      reports the degraded tier instead of silently pretending success.
//    · Payload caps: the transport cap is sufficient for the product's own
//      worst-case legal frame (2x headroom law), and oversized text /
//      attachment lists / reasons are refused with VALIDATION_ERROR.
//    · Observability: a refusal logs metadata only — bounded vocabulary,
//      server-derived ids — and message CONTENT never reaches any log line
//      (a sentinel body must not appear in captured output).
//    · WIRING: every route the chat router exposes really carries a limiter
//      (policy tables can be perfect while a route forgets to mount one), and
//      the diagnostics block is numbers/safe-words only.
//    · NO IDENTITY IS BLOCKED FOREVER: a window whose EXPIRE failed (a Redis
//      op timeout is enough) leaves a TTL-less counter that would refuse that
//      identity until someone deleted the key by hand — the field symptom was
//      a permanent `POST /api/auth/refresh 429`. The refusal path re-asserts
//      the TTL, and the identity recovers within ONE window.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_hardening';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import {
  CHAT_REST_LIMITS,
  CHAT_SOCKET_LIMITS,
  chatRestLimiters,
  chatRestIdentity,
  createChatSocketRateLimiter,
} from '../src/services/chat/chatRateLimitService.js';
import { securityRateLimit } from '../src/middlewares/securityRateLimit.js';
import { createRateLimitStore, resetRateLimitStoreForTests } from '../src/utils/rateLimitStore.js';
import {
  CHAT_LIMIT_ACTIONS,
  logChatRateLimited,
} from '../src/utils/chatObservability.js';
import {
  CHAT_FRAME_CAP_HEADROOM_FACTOR,
  CHAT_MESSAGE_TEXT_MAX,
  CHAT_ATTACHMENT_MAX_PER_MESSAGE,
  describeFrameCaps,
  frameCapIsSufficient,
  worstCaseFrameBytes,
} from '../src/utils/chatPayloadCaps.js';
import { CHAT_MAX_HTTP_BUFFER_BYTES } from '../src/socket/socketConfig.js';
import {
  validateDeletePayload,
  validateSendFilePayload,
  validateSendPayload,
} from '../src/socket/chatSocketValidators.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import { getMetricsRegistry } from '../src/infrastructure/observability/metricsRegistry.js';

const { ObjectId } = mongoose.Types;
const id = () => new ObjectId();

const COMPANY_A = id();
const COMPANY_B = id();
const USER_1 = id();
const USER_2 = id();

// ── a fake Redis io for the real store (no live server anywhere) ──────────

const fakeRedisIo = () => {
  const counters = new Map();

  return {
    incr: async (key) => {
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      return next;
    },
    get: async (key) => (counters.has(key) ? counters.get(key) : null),
    del: async (key) => {
      counters.delete(key);
    },
    size: () => counters.size,
  };
};

// ── express-shaped fakes ─────────────────────────────────────────────────

const makeRes = () => {
  const res = {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(key, value) {
      res.headers[key] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };

  return res;
};

const run = async (middleware, req) => {
  const res = makeRes();
  let nexted = false;

  await middleware(req, res, () => {
    nexted = true;
  });

  return { res, nexted };
};

const restReq = ({ companyId = COMPANY_A, userId = USER_1 } = {}) => ({
  ip: '127.0.0.1',
  originalUrl: '/api/chat/conversations',
  companyId,
  user: { _id: userId },
  body: {},
});

// ══════════════════════════════════════════════════════════════════════════
// 1. REST — threshold, error shape, headers
// ══════════════════════════════════════════════════════════════════════════

test('a restricted chat action refuses with 429 after its threshold', async () => {
  resetRateLimitStoreForTests();

  const maximum = 3;
  const limiter = securityRateLimit({
    sharedName: `hardening-rest-${id()}`,
    windowMs: 60_000,
    maximum,
    keyGenerator: chatRestIdentity,
    store: createRateLimitStore({
      sharedName: `hardening-rest-${id()}`,
      windowMs: 60_000,
      io: fakeRedisIo(),
    }),
  });

  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const { res, nexted } = await run(limiter, restReq());

    assert.equal(nexted, true, `attempt ${attempt} must pass`);
    assert.equal(res.statusCode, null);
    assert.equal(res.headers['X-RateLimit-Limit'], maximum);
    assert.equal(res.headers['X-RateLimit-Remaining'], maximum - attempt);
  }

  const refused = await run(limiter, restReq());

  assert.equal(refused.nexted, false, 'the over-limit request must not reach the route');
  assert.equal(refused.res.statusCode, 429);
  assert.equal(refused.res.body.code, 'RATE_LIMITED');
  assert.equal(refused.res.body.success, false);
  assert.equal(refused.res.body.statusCode, 429);
  assert.ok(refused.res.headers['Retry-After'] >= 1);
});

test('the budget is per tenant AND per user — no cross-tenant starvation', async () => {
  resetRateLimitStoreForTests();

  const shared = createRateLimitStore({
    sharedName: `hardening-tenant-${id()}`,
    windowMs: 60_000,
    io: fakeRedisIo(),
  });

  const limiter = securityRateLimit({
    sharedName: 'hardening-tenant',
    windowMs: 60_000,
    maximum: 2,
    keyGenerator: chatRestIdentity,
    store: shared,
  });

  // Company A / user 1 exhausts its own budget.
  await run(limiter, restReq());
  await run(limiter, restReq());
  const aRefused = await run(limiter, restReq());

  assert.equal(aRefused.res.statusCode, 429, 'A is limited');

  // Another company, and another user in the same company, are untouched.
  const otherCompany = await run(limiter, restReq({ companyId: COMPANY_B }));
  const otherUser = await run(limiter, restReq({ userId: USER_2 }));

  assert.equal(otherCompany.nexted, true, 'company B keeps its own budget');
  assert.equal(otherUser.nexted, true, 'and so does another user of company A');

  // …and the identity really is the pair, not the IP.
  assert.equal(chatRestIdentity(restReq()), `${COMPANY_A}:${USER_1}`);
  assert.equal(chatRestIdentity(restReq({ companyId: COMPANY_B })), `${COMPANY_B}:${USER_1}`);
});

test('every chat REST action has a policy and a built middleware', () => {
  const actions = Object.keys(CHAT_REST_LIMITS);

  assert.ok(actions.length >= 10, 'all chat REST surfaces are covered');

  for (const action of actions) {
    const policy = CHAT_REST_LIMITS[action];

    assert.ok(policy.windowMs >= 1000, `${action} window`);
    assert.ok(policy.maximum >= 1, `${action} maximum`);
    assert.equal(typeof chatRestLimiters[action], 'function', `${action} middleware`);
    assert.ok(CHAT_LIMIT_ACTIONS.includes(action), `${action} is in the log vocabulary`);
  }

  // The strict/expensive operations are stricter than the reads.
  assert.ok(CHAT_REST_LIMITS['attachment.upload'].maximum < CHAT_REST_LIMITS['conversation.list'].maximum);
  assert.ok(CHAT_REST_LIMITS['conversation.create'].maximum <= 10);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Degraded tiers — never fail-open
// ══════════════════════════════════════════════════════════════════════════

test('with Redis intentionally disabled the limiter still limits (local tier)', async () => {
  resetRateLimitStoreForTests();

  // No injected io and no Redis client (getRedisClient() is null when
  // REDIS_ENABLED is not 'true') — the documented quiet local mode.
  const store = createRateLimitStore({ sharedName: `hardening-local-${id()}`, windowMs: 60_000 });

  const limiter = securityRateLimit({
    sharedName: 'hardening-local',
    windowMs: 60_000,
    maximum: 2,
    keyGenerator: chatRestIdentity,
    store,
  });

  const tiers = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const verdict = await store.hit('identity', 2);
    tiers.push(verdict.tier);
  }

  assert.deepEqual(tiers, ['local', 'local', 'local'], 'quiet local mode, no circuit warning');

  await run(limiter, restReq());
  await run(limiter, restReq());
  const refused = await run(limiter, restReq());

  assert.equal(refused.res.statusCode, 429, 'degraded is NOT unlimited');
});

test('a dead Redis degrades to the bounded local bucket, never to unlimited', async () => {
  resetRateLimitStoreForTests();

  let calls = 0;
  const deadIo = {
    incr: async () => {
      calls += 1;
      throw new Error('redis is down');
    },
    get: async () => {
      throw new Error('redis is down');
    },
    del: async () => {
      throw new Error('redis is down');
    },
  };

  const store = createRateLimitStore({
    sharedName: `hardening-dead-${id()}`,
    windowMs: 60_000,
    io: deadIo,
  });

  const hits = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    hits.push(await store.hit('one-identity', 2));
  }

  assert.equal(hits[0].limited, false);
  assert.equal(hits[1].limited, false);
  assert.equal(hits[2].limited, true, 'the third hit over a limit of 2 is refused');
  assert.equal(hits[2].tier, 'local');

  // The circuit opened: further hits do not pound a dead Redis.
  const callsAfterFirstFailure = calls;

  await store.hit('one-identity', 2);
  await store.hit('one-identity', 2);

  assert.equal(calls, callsAfterFirstFailure, 'circuit breaker stops the failing round-trips');
});

test('a normal request passes while Redis is dead (degrade, not fail-closed)', async () => {
  resetRateLimitStoreForTests();

  const dead = () => {
    throw new Error('redis is down');
  };

  const limiter = securityRateLimit({
    sharedName: 'hardening-degrade-open',
    windowMs: 60_000,
    maximum: 5,
    keyGenerator: chatRestIdentity,
    store: createRateLimitStore({
      sharedName: `hardening-degrade-open-${id()}`,
      windowMs: 60_000,
      io: { incr: async () => dead(), get: async () => dead(), del: async () => dead() },
    }),
  });

  const { res, nexted } = await run(limiter, restReq());

  // "Never fail open" is about the ABUSE control (over-limit requests are still
  // refused, and a throwing store refuses rather than admits). It must not
  // become "fail closed for everybody": a dead Redis cannot lock every user out
  // of their own inbox, because history lives in Mongo.
  assert.equal(nexted, true, 'a legitimate request is NOT blocked because Redis is down');
  assert.equal(res.statusCode, null);
});

test('the socket limiter reports the degraded tier instead of hiding it', async () => {
  const events = [];
  const log = { warn: (message, meta) => events.push([message, meta]) };

  const limiter = createChatSocketRateLimiter({
    log,
    _storeFactory: () => ({
      hit: async () => ({ limited: true, count: 9, remaining: 0, resetAt: Date.now() + 5000, tier: 'local' }),
    }),
  });

  const verdict = await limiter({ action: 'message.send', companyId: COMPANY_A, userId: USER_1 });

  assert.equal(verdict.limited, true);
  assert.equal(verdict.tier, 'local');

  const [message, meta] = events[0];

  assert.equal(message, 'chat.rate_limited');
  assert.equal(meta.tier, 'local', 'ops can tell a degraded deployment from real abuse');
  assert.equal(meta.action, 'message.send');
});

test('a limiter store that throws is a REFUSAL, never an open door', async () => {
  const limiter = createChatSocketRateLimiter({
    _storeFactory: () => ({
      hit: async () => {
        throw new Error('store exploded');
      },
    }),
  });

  const verdict = await limiter({ action: 'message.send', companyId: COMPANY_A, userId: USER_1 });

  assert.equal(verdict.limited, true, 'an abuse control must fail closed');
  assert.ok(verdict.retryAfterMs > 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Socket handlers — real handlers, injected limiter
// ══════════════════════════════════════════════════════════════════════════

const makeSocket = (companyId = COMPANY_A, userId = USER_1) => {
  const handlers = new Map();

  return {
    data: { companyId: String(companyId), userId: String(userId) },
    on: (event, handler) => handlers.set(event, handler),
    join: () => {},
    leave: () => {},
    emit: () => {},
    handlers,
  };
};

const call = (handlers, event, payload) =>
  new Promise((resolve) => {
    handlers.get(event)(payload, resolve);
  });

test('the socket refuses with the stable RATE_LIMITED ACK after the threshold', async () => {
  const socket = makeSocket();
  const seen = [];
  let work = 0;

  // A real per-action limiter over an in-memory counter — no Redis.
  const counters = new Map();
  const limiter = createChatSocketRateLimiter({
    _storeFactory: ({ sharedName, windowMs }) => ({
      hit: async (identityKey, maximum) => {
        const key = `${sharedName}:${identityKey}`;
        const count = (counters.get(key) || 0) + 1;
        counters.set(key, count);
        return { limited: count > maximum, count, remaining: 0, resetAt: Date.now() + windowMs, tier: 'shared' };
      },
    }),
  });

  registerChatSocketHandlers({
    io: { to: () => ({ emit: () => {} }) },
    socket,
    log: { warn: () => {}, error: () => {}, info: () => {} },
    limitRate: async (args) => {
      seen.push(args);
      return limiter(args);
    },
    loadConversation: async () => ({ _id: id(), isDisabled: false }),
    sendFile: async () => ({ ok: true, created: false, message: {} }),
    editMessage: async () => ({ ok: true, changed: false, message: {} }),
    deleteMessage: async () => ({ ok: true, changed: false, messageId: id(), deletedAt: new Date() }),
    markRead: async () => ({ ok: true, myLastReadSeq: 1, unreadCount: 0 }),
    sendMessage: async () => {
      work += 1;
      return { ok: true, created: true, message: { _id: id(), seq: 1, senderUserId: USER_1, type: 'TEXT', text: 'hi', attachments: [], editVersion: 0, deletedAt: null, createdAt: new Date() } };
    },
  });

  const maximum = CHAT_SOCKET_LIMITS['message.send'].maximum;

  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const ack = await call(socket.handlers, 'chat:message:send', {
      conversationId: String(id()),
      clientMessageId: `c-${attempt}`,
      text: `hello ${attempt}`,
    });

    assert.equal(ack.ok, true, `send ${attempt} must pass`);
  }

  const refused = await call(socket.handlers, 'chat:message:send', {
    conversationId: String(id()),
    clientMessageId: 'c-over',
    text: 'one too many',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'RATE_LIMITED');
  assert.equal(refused.message, 'Too many messages. Slow down and retry.');
  assert.equal(work, maximum, 'the refused send never reached the service');

  // The identity handed to the limiter is the SOCKET's, and the action is the
  // policy key — never anything from the payload.
  assert.ok(seen.length >= maximum);
  assert.equal(seen[0].action, 'message.send');
  assert.equal(String(seen[0].companyId), String(COMPANY_A));
  assert.equal(String(seen[0].userId), String(USER_1));
  assert.equal(seen[0].companyIdFromPayload, undefined);
});

test('a payload claiming another identity cannot move the socket bucket', async () => {
  const socket = makeSocket(COMPANY_A, USER_1);
  const identities = [];

  registerChatSocketHandlers({
    io: { to: () => ({ emit: () => {} }) },
    socket,
    log: { warn: () => {}, error: () => {}, info: () => {} },
    // Records the identity the handler supplied and always allows.
    limitRate: async ({ action, companyId, userId: who }) => {
      identities.push({ action, companyId: String(companyId), userId: String(who) });
      return { limited: false, tier: 'shared' };
    },
    loadConversation: async () => ({ _id: id(), isDisabled: false }),
    sendMessage: async () => ({
      ok: true,
      created: true,
      message: { _id: id(), seq: 2, senderUserId: USER_1, type: 'TEXT', text: 'hi', attachments: [], editVersion: 0, deletedAt: null, createdAt: new Date() },
    }),
  });

  await call(socket.handlers, 'chat:message:send', {
    conversationId: String(id()),
    clientMessageId: 'forged',
    text: 'hello',
    // A hostile payload: ids it does not own.
    companyId: String(COMPANY_B),
    userId: String(USER_2),
    senderUserId: String(USER_2),
  });

  assert.equal(identities.length, 1);
  assert.equal(identities[0].companyId, String(COMPANY_A), 'socket.data wins, always');
  assert.equal(identities[0].userId, String(USER_1));
});

test('every writing socket event is gated by an identity limit', () => {
  const socket = makeSocket();
  const actions = [];

  registerChatSocketHandlers({
    io: { to: () => ({ emit: () => {} }) },
    socket,
    log: { warn: () => {}, error: () => {}, info: () => {} },
    limitRate: async ({ action }) => {
      actions.push(action);
      return { limited: false, tier: 'shared' };
    },
    // Every service is stubbed: this test is about WHICH gates run, not about
    // persistence — and a hermetic suite must never reach a driver timeout.
    loadConversation: async () => ({ _id: id(), isDisabled: false }),
    markRead: async () => ({ ok: true, myLastReadSeq: 1, unreadCount: 0 }),
    linkAttachments: async () => [],
    sendMessage: async () => ({ ok: true, created: false, message: {} }),
    sendFile: async () => ({ ok: true, created: false, message: {} }),
    editMessage: async () => ({ ok: true, changed: false, message: {} }),
    deleteMessage: async () => ({ ok: true, changed: false, messageId: id(), deletedAt: new Date() }),
  });

  const calls = [
    ['chat:join', { conversationId: String(id()) }],
    ['chat:message:send', { conversationId: String(id()), clientMessageId: 'a', text: 'hi' }],
    ['chat:message:sendFile', { conversationId: String(id()), clientMessageId: 'b', attachmentIds: [String(id())] }],
    ['chat:message:edit', { conversationId: String(id()), messageId: String(id()), expectedEditVersion: 0, newText: 'x' }],
    ['chat:message:delete', { conversationId: String(id()), messageId: String(id()) }],
    ['chat:readUpTo', { conversationId: String(id()), lastReadSeq: 1 }],
  ];

  return (async () => {
    for (const [event, payload] of calls) {
      await call(socket.handlers, event, payload);
    }

    assert.deepEqual(
      actions,
      ['socket.join', 'message.send', 'message.sendFile', 'message.edit', 'message.delete', 'socket.readUpTo'],
      'one gate per event, in the policy vocabulary',
    );

    for (const action of actions) {
      assert.ok(CHAT_SOCKET_LIMITS[action], `${action} has a policy`);
    }

    // chat:leave does NOT need a limit (it frees a room) — it must not be gated.
    assert.equal(socket.handlers.has('chat:leave'), true);
    assert.equal(actions.includes('socket.leave'), false);
  })();
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Payload caps
// ══════════════════════════════════════════════════════════════════════════

test('the transport cap is sufficient for the product own worst-case frame', () => {
  const caps = describeFrameCaps(CHAT_MAX_HTTP_BUFFER_BYTES);

  assert.equal(caps.sufficient, true, `cap ${caps.capBytes} vs worst case ${caps.worstCaseFrameBytes}`);
  assert.ok(caps.headroomBytes > 0);

  // The 2x headroom law, stated as the law rather than as a magic number.
  assert.equal(CHAT_FRAME_CAP_HEADROOM_FACTOR, 2);
  assert.ok(
    CHAT_MAX_HTTP_BUFFER_BYTES >= CHAT_FRAME_CAP_HEADROOM_FACTOR * worstCaseFrameBytes(),
    'a future product-cap raise must fail HERE instead of failing in a user session',
  );

  // Still conservative against the transport default (1 MB).
  assert.ok(CHAT_MAX_HTTP_BUFFER_BYTES < 1024 * 1024);
  assert.ok(CHAT_MAX_HTTP_BUFFER_BYTES <= 64 * 1024);

  // The bound really covers a max emoji caption + the maximum file list.
  const emojiText = '\u{1F600}'.repeat(CHAT_MESSAGE_TEXT_MAX);
  const worstFrame = Buffer.byteLength(
    JSON.stringify([
      'chat:message:sendFile',
      {
        conversationId: '6a0b3b552c27ad18b96de2be',
        clientMessageId: 'c'.repeat(80),
        attachmentIds: Array.from({ length: CHAT_ATTACHMENT_MAX_PER_MESSAGE }, () => 'a'.repeat(24)),
        text: emojiText,
      },
    ]),
  );

  assert.ok(
    worstFrame <= CHAT_MAX_HTTP_BUFFER_BYTES,
    `measured worst frame ${worstFrame}B must fit the cap ${CHAT_MAX_HTTP_BUFFER_BYTES}B`,
  );
  assert.ok(frameCapIsSufficient(CHAT_MAX_HTTP_BUFFER_BYTES));
});

test('oversized payloads are refused with VALIDATION_ERROR, not truncation', () => {
  const conversationId = String(id());

  const longText = validateSendPayload({
    conversationId,
    clientMessageId: 'c1',
    text: 'x'.repeat(CHAT_MESSAGE_TEXT_MAX + 1),
  });

  assert.equal(longText.ok, false);
  assert.equal(longText.code, 'VALIDATION_ERROR');
  assert.match(longText.message, /at most/);

  const tooMany = validateSendFilePayload({
    conversationId,
    clientMessageId: 'c2',
    attachmentIds: Array.from({ length: CHAT_ATTACHMENT_MAX_PER_MESSAGE + 1 }, () => String(id())),
  });

  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /at most 5 files/);

  const longReason = validateDeletePayload({
    conversationId,
    messageId: String(id()),
    reason: 'r'.repeat(201),
  });

  assert.equal(longReason.ok, false);
  assert.match(longReason.message, /reason must be at most/);

  // Boundaries still pass (no off-by-one tightening).
  assert.equal(
    validateSendPayload({ conversationId, clientMessageId: 'c3', text: 'x'.repeat(CHAT_MESSAGE_TEXT_MAX) }).ok,
    true,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 5. Observability — metadata only, content never
// ══════════════════════════════════════════════════════════════════════════

test('a refusal logs bounded metadata and never message content', () => {
  const lines = [];
  const log = { warn: (message, meta) => lines.push({ message, meta }) };

  const SENTINEL = 'salary-details-of-employee-42.pdf';

  const logged = logChatRateLimited({
    surface: 'socket',
    action: 'message.sendFile',
    companyId: COMPANY_A,
    userId: USER_1,
    tier: 'shared',
    count: 21,
    maximum: 20,
    windowMs: 60_000,
    log,
    // Deliberately hostile extras: they must be IGNORED, not forwarded.
    text: SENTINEL,
    fileName: SENTINEL,
    storageKey: 'crewly-private-chat-attachments/x/y/z',
    token: 'Bearer abc.def.ghi',
  });

  assert.equal(logged, true);
  assert.equal(lines.length, 1);

  const [entry] = lines;

  assert.equal(entry.message, 'chat.rate_limited');
  assert.deepEqual(Object.keys(entry.meta).sort(), [
    'action', 'companyId', 'count', 'maximum', 'surface', 'tier', 'userId', 'windowMs',
  ]);

  const serialized = JSON.stringify(entry);

  assert.ok(!serialized.includes(SENTINEL), 'content never reaches a log line');
  assert.ok(!serialized.includes('crewly-private'), 'no storage keys');
  assert.ok(!serialized.includes('abc.def.ghi'), 'no tokens');
  assert.ok(!serialized.includes('@'), 'no emails/addresses of any kind');
});

test('an unknown action or surface is refused by the vocabulary (fail closed)', () => {
  const lines = [];
  const log = { warn: (...args) => lines.push(args) };

  assert.equal(logChatRateLimited({ surface: 'socket', action: 'message.telepathy', log }), false);
  assert.equal(logChatRateLimited({ surface: 'carrier-pigeon', action: 'message.send', log }), false);
  assert.equal(lines.length, 0, 'nothing unrecognized is ever logged');

  // A hostile id is bounded rather than logged.
  logChatRateLimited({
    surface: 'rest',
    action: 'message.send',
    companyId: 'x'.repeat(500),
    userId: 'y'.repeat(500),
    tier: 'shared',
    log,
  });

  const [, meta] = lines[0];

  assert.equal(meta.companyId, undefined);
  assert.equal(meta.userId, undefined);
});

test('refusals increment the bounded metrics families', () => {
  const registry = getMetricsRegistry();
  const before = JSON.stringify(registry.snapshot()['chat.rate_limited'] ?? []);

  logChatRateLimited({
    surface: 'rest',
    action: 'attachment.upload',
    companyId: COMPANY_A,
    userId: USER_1,
    tier: 'local',
    count: 21,
    maximum: 20,
    windowMs: 600_000,
    log: { warn: () => {} },
  });

  const snapshot = registry.snapshot();

  assert.ok(snapshot['chat.rate_limited'], 'the family exists in the diagnostics snapshot');
  assert.ok(
    snapshot['chat.rate_limited'].some((entry) => entry.labels.action === 'attachment.upload'),
    'labeled by action',
  );
  assert.ok(
    snapshot['chat.rate_limit_degraded'].some((entry) => entry.labels.tier === 'local'),
    'and the degraded tier is visible to ops',
  );
  assert.notEqual(JSON.stringify(registry.snapshot()['chat.rate_limited']), before);

  // The registry still refuses unknown labels (no cardinality leak).
  assert.equal(registry.increment('chat.rate_limited', { action: 'x', userId: 'y' }), false);
});

// ══════════════════════════════════════════════════════════════════════════
// 6. WIRING — the limiter must be MOUNTED, not merely defined
// ══════════════════════════════════════════════════════════════════════════

test('every route in the chat router carries an identity limiter', async () => {
  const { chatRoutes } = await import('../src/routes/chat/chatRoutes.js');

  const limiters = new Set(Object.values(chatRestLimiters));

  const routes = chatRoutes.stack
    .map((layer) => layer.route)
    .filter(Boolean);

  assert.ok(routes.length >= 12, `the chat router exposes its routes (${routes.length} found)`);

  const unmounted = [];

  for (const route of routes) {
    const hasLimiter = route.stack.some((layer) => limiters.has(layer.handle));

    if (!hasLimiter) {
      const methods = Object.keys(route.methods).join(',').toUpperCase();
      unmounted.push(`${methods} ${route.path}`);
    }
  }

  assert.deepEqual(
    unmounted,
    [],
    'a chat route without an identity limiter is an unlimited abuse surface',
  );
});

test('each limited route mounts the limiter for ITS action', async () => {
  const { chatRoutes } = await import('../src/routes/chat/chatRoutes.js');

  const expected = [
    ['post', '/conversations', 'conversation.create'],
    ['get', '/conversations', 'conversation.list'],
    ['get', '/conversations/:conversationId', 'conversation.detail'],
    ['get', '/conversations/:conversationId/messages', 'message.history'],
    ['post', '/conversations/:conversationId/members', 'conversation.members.add'],
    ['delete', '/conversations/:conversationId/members/:userId', 'conversation.members.remove'],
    ['post', '/conversations/:conversationId/read', 'message.read'],
    ['patch', '/conversations/:conversationId/disable', 'conversation.moderateState'],
    ['patch', '/conversations/:conversationId/enable', 'conversation.moderateState'],
    ['post', '/conversations/:conversationId/messages/:messageId/moderate-delete', 'message.moderateDelete'],
    ['post', '/conversations/:conversationId/attachments', 'attachment.upload'],
    ['get', '/attachments/:attachmentId/download', 'attachment.download'],
  ];

  for (const [method, path, action] of expected) {
    const route = chatRoutes.stack
      .map((layer) => layer.route)
      .find((candidate) => candidate?.path === path && candidate?.methods?.[method]);

    assert.ok(route, `${method.toUpperCase()} ${path} exists`);

    assert.ok(
      route.stack.some((layer) => layer.handle === chatRestLimiters[action]),
      `${method.toUpperCase()} ${path} must mount the "${action}" limiter`,
    );
  }

  // …and the limiter runs BEFORE the controller (a limit after the work is
  // not a limit).
  const route = chatRoutes.stack
    .map((layer) => layer.route)
    .find((candidate) => candidate?.path === '/conversations' && candidate?.methods?.post);

  const limiterIndex = route.stack.findIndex((layer) => layer.handle === chatRestLimiters['conversation.create']);
  const controllerIndex = route.stack.findIndex((layer) => /upload|create|list/i.test(layer.name || ''));

  assert.ok(limiterIndex >= 0, 'the limiter is mounted');
  assert.ok(controllerIndex === -1 || limiterIndex < controllerIndex, 'limiter before controller');
});

// ══════════════════════════════════════════════════════════════════════════
// 7. OPERATIONAL DIAGNOSTICS — numbers and safe words only
// ══════════════════════════════════════════════════════════════════════════

test('the chat diagnostics block is safe, bounded and complete', async () => {
  const { getChatDiagnostics } = await import('../src/services/chat/chatDiagnosticsService.js');
  const { CHAT_REALTIME_STATES, CHAT_UNAVAILABLE_REASONS } = await import('../src/socket/socketAvailability.js');

  const diagnostics = getChatDiagnostics();

  // Realtime: a state from the frozen vocabulary + a bounded counter set.
  assert.ok(
    Object.values(CHAT_REALTIME_STATES).includes(diagnostics.realtime.state),
    `state must be a known word, got ${diagnostics.realtime.state}`,
  );
  if (diagnostics.realtime.reason !== null) {
    assert.ok(CHAT_UNAVAILABLE_REASONS.includes(diagnostics.realtime.reason));
  }
  assert.equal(typeof diagnostics.realtime.enabled, 'boolean');
  assert.equal(typeof diagnostics.realtime.localConnections, 'number');

  // Payload: the transport-vs-product law, as numbers.
  assert.equal(diagnostics.payload.sufficient, true);
  assert.ok(diagnostics.payload.capBytes > diagnostics.payload.worstCaseFrameBytes);

  // Limits: EVERY action in both tables is visible to ops.
  assert.deepEqual(
    Object.keys(diagnostics.limits.rest).sort(),
    Object.keys(CHAT_REST_LIMITS).sort(),
  );
  assert.deepEqual(
    Object.keys(diagnostics.limits.socket).sort(),
    Object.keys(CHAT_SOCKET_LIMITS).sort(),
  );

  for (const policy of Object.values(diagnostics.limits.rest)) {
    assert.ok(Number.isFinite(policy.maximum) && policy.maximum > 0);
    assert.ok(Number.isFinite(policy.windowSeconds) && policy.windowSeconds > 0);
  }

  // Nothing sensitive: no ids, no limiter keys, no URLs, no secrets, no
  // per-user anything.
  const flat = JSON.stringify(diagnostics);

  for (const forbidden of ['crewly:', 'rl:', 'redis://', 'rediss://', 'Bearer', 'companyId', 'userId', 'socket.id', 'storageKey', 'token']) {
    assert.ok(!flat.includes(forbidden), `diagnostics must not contain "${forbidden}"`);
  }
});

test('the diagnostics endpoint exposes the chat block through the existing pattern', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const controller = fs.readFileSync(
    path.join(here, '..', 'src', 'controllers', 'platform', 'superAdminOperationsController.js'),
    'utf8',
  );

  // The EXISTING platform diagnostics payload gained one block — no new
  // endpoint, no /metrics, no new vendor.
  assert.match(controller, /import \{ getChatDiagnostics \}/);
  assert.match(controller, /chat: getChatDiagnostics\(\)/);
  assert.match(controller, /realtime: realtime\.describeDiagnostics\(\)/, 'the pattern it follows');
});

// ══════════════════════════════════════════════════════════════════════════
// 8. THE USER SEES THE LIMIT (frontend, source-pinned: no test harness exists)
// ══════════════════════════════════════════════════════════════════════════

test('a rate-limited send shows the server sentence, not a generic failure', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const frontend = (rel) => fs.readFileSync(path.join(here, '..', '..', 'Frontend', 'src', rel), 'utf8');

  const page = frontend('pages/chat/ChatPage.jsx');

  // handleSend returns the ACK's own message, so "Too many messages. Slow
  // down and retry." reaches the composer instead of a generic line.
  assert.match(page, /return ack\.message \|\| 'The message could not be sent\.'/, 'the ACK message is surfaced');
  assert.match(page, /ack\.code === 'FEATURE_UNAVAILABLE'/, 'degraded realtime keeps its own sentence');

  const composer = frontend('components/chat/MessageComposer.jsx');

  assert.match(composer, /if \(failure\) \{/, 'the composer inspects the failure');
  assert.match(composer, /setError\(failure\)/, 'and shows it to the sender');
  // Shape-tolerant on purpose: the pin is "the failure is rendered as a
  // paragraph above the composer", not "it is written on one line". A UI pass
  // that adds role="alert" and a wrapper paren must not read as a regression.
  assert.match(composer, /\{error && \(\s*<p[^>]*>\s*\{error\}/, 'rendered above the composer');

  // REST limits (upload 429) surface the server's sentence — the picker reads
  // the normalized error from services/api.js.
  const picker = frontend('components/chat/AttachmentPicker.jsx');

  assert.match(picker, /err\?\.data\?\.message \|\| err\?\.message/);
});

// ══════════════════════════════════════════════════════════════════════════
// 9. DEPLOYMENT PRE-FLIGHT
// ══════════════════════════════════════════════════════════════════════════

test('config-check reports chat enablement, the cap law and the limiter tier', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = fs.readFileSync(path.join(here, '..', 'scripts', 'config-check.js'), 'utf8');

  assert.match(script, /parseChatSocketEnabled/, 'chat enablement is reported');
  assert.match(script, /describeFrameCaps/, 'the cap law is reported');
  assert.match(script, /CHAT_SOCKET_FRAME_CAP/);
  assert.match(script, /CHAT_RATE_LIMIT_TIER/);
  // Enabled chat without Redis can never work (33.1) — reported loudly, but
  // DELIBERATELY not a blocked deployment: the product degrades truthfully
  // (API up, REST fine, sockets refused with a stable code) and pre-flight
  // must not contradict that. Pinned so a future change to hard-fail here is
  // a conscious decision, not an accident.
  assert.match(script, /CHAT_REALTIME_DEPENDENCY/);
  assert.match(script, /every socket connection will be refused/);
  assert.ok(
    !/problems\.push\('CHAT_SOCKET_ENABLED=true requires/.test(script),
    'chat enablement is a warning, never a hard pre-flight failure',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 10. A LIMITER MUST NEVER BLOCK AN IDENTITY FOREVER
// ══════════════════════════════════════════════════════════════════════════

/**
 * Redis double that models the failure that matters: the FIRST-hit EXPIRE
 * (the call that gives a window its life) times out, so the counter is left
 * with no TTL — immortal until something heals it.
 */
const makeImmortalKeyIo = ({ healWorks = true } = {}) => {
  const counters = new Map();
  const ttls = new Map();
  const calls = { incr: 0, expire: 0, expireIfMissing: 0 };

  const alive = (key) => {
    const expiresAt = ttls.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      counters.delete(key);
      ttls.delete(key);
    }
    return counters.has(key);
  };

  return {
    calls,
    ttls,
    incr: async (key) => {
      calls.incr += 1;
      if (!alive(key)) counters.set(key, 0);
      const next = counters.get(key) + 1;
      counters.set(key, next);
      return next;
    },
    get: async (key) => (alive(key) ? counters.get(key) : null),
    del: async (key) => {
      counters.delete(key);
      ttls.delete(key);
    },
    // The window TTL is NEVER applied here: this is the failure being modelled.
    setWindowTtl: () => false,
    expireIfMissing: async (key) => {
      calls.expireIfMissing += 1;
      if (!healWorks) return false;
      if (ttls.has(key)) return false; // NX semantics: never extend a live window
      ttls.set(key, Date.now() + 1000);
      return true;
    },
  };
};

test('a window whose EXPIRE failed can no longer block an identity forever', async () => {
  resetRateLimitStoreForTests();

  const io = makeImmortalKeyIo();

  // A short window: ttlSeconds = 1, and the fake honours it after healing.
  const store = createRateLimitStore({ sharedName: `hardening-immortal-${id()}`, windowMs: 1000, io });

  const maximum = 2;

  const hits = [];

  for (let attempt = 1; attempt <= maximum + 1; attempt += 1) {
    hits.push(await store.hit('stuck-identity', maximum));
  }

  assert.deepEqual(hits.map((entry) => entry.limited), [false, false, true]);
  assert.equal(hits[2].tier, 'shared');

  // THE FIX: refusing repaired the missing TTL…
  assert.equal(io.calls.expireIfMissing, 1, 'the refusal re-asserted the window TTL');
  assert.ok(io.ttls.get([...io.ttls.keys()][0]) > Date.now(), 'a TTL now exists');

  // …so the identity recovers by itself, with no operator touching Redis.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const afterWindow = await store.hit('stuck-identity', maximum);

  assert.equal(afterWindow.limited, false, 'the next window starts fresh');
  assert.equal(afterWindow.count, 1);
});

test('healing is best effort: a failed heal cannot change the refusal', async () => {
  resetRateLimitStoreForTests();

  const io = makeImmortalKeyIo({ healWorks: false });
  const store = createRateLimitStore({ sharedName: `hardening-heal-fail-${id()}`, windowMs: 1000, io });

  await store.hit('identity', 1);
  const refused = await store.hit('identity', 1);

  // The heal attempted and returned false (e.g. Redis still timing out) —
  // the answer is unchanged and the caller never sees an exception.
  assert.equal(refused.limited, true);
  assert.equal(io.calls.expireIfMissing, 1);
  assert.ok(io.ttls.size === 0, 'nothing was healed, and nothing was thrown');
});

test('an io without the optional heal method still behaves exactly as before', async () => {
  resetRateLimitStoreForTests();

  // Legacy/test doubles implement only incr/get/del. The store must not
  // require the new method (no crash, no behaviour change).
  const counters = new Map();
  const legacyIo = {
    incr: async (key) => {
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      return next;
    },
    get: async (key) => counters.get(key) ?? null,
    del: async (key) => counters.delete(key),
  };

  const store = createRateLimitStore({ sharedName: `hardening-legacy-${id()}`, windowMs: 1000, io: legacyIo });

  // Also: the heal is attempted but optional, so refusals still work.
  assert.equal((await store.hit('identity', 1)).limited, false);
  assert.equal((await store.hit('identity', 1)).limited, true);
});
