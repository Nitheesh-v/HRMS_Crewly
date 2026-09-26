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
