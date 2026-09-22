// ═══════════════════════════════════════════════════════════════════════════
// Phase 33.1A — SOCKET.IO FOUNDATION (hermetic)
//
// No live Redis, no live Mongo, no network: the gateway is exercised through
// injected fakes (ioFactory / adapterBuilder / models / availability), which is
// also the point — the module must be testable without a broker.
//
// Laws pinned here:
//   · explicit enable flag (never Boolean(env))
//   · infrastructure-only event vocabulary (no chat/presence/typing yet)
//   · bounded payloads; malformed frames are DROPPED, never thrown
//   · tenant-only handshake: kiosk / verifier / platform principals refused
//   · refusals carry a generic code only — no reason, token, id or stack
//   · cookie:false + websocket-only + strict CORS
//   · truthful degradation: Redis unavailable ⇒ every handshake refused
//   · bounded capacity per user and per process
//   · stop() disconnects clients and NEVER closes the http.Server
// ═══════════════════════════════════════════════════════════════════════════
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import jwt from 'jsonwebtoken';
import env from '../src/config/env.js';

const { parseSocketEnabled, SOCKET_EVENT_TYPES, SOCKET_MAX_PAYLOAD_BYTES,
  SOCKET_MAX_SOCKETS_PER_PROCESS, SOCKET_MAX_SOCKETS_PER_USER,
  SOCKET_ERROR_CODES, socketAdapterKey } = await import(
  '../src/infrastructure/socket/socketConfig.js'
);
const { createSocketRegistry } = await import(
  '../src/infrastructure/socket/socketRegistry.js'
);
const { isAllowedSocketEventType, parseSocketCommand, buildSocketFrame } =
  await import('../src/infrastructure/socket/socketProtocol.js');
const { verifySocketHandshake, SOCKET_AUTH_REASONS } = await import(
  '../src/infrastructure/socket/socketAuth.js'
);
const { createSocketGateway } = await import(
  '../src/infrastructure/socket/socketGateway.js'
);

// ── Fakes ──────────────────────────────────────────────────────────────────

const createFakeIo = () => {
  const state = {
    middlewares: [],
    connectionHandlers: [],
    adapterSet: null,
    disconnected: false,
    removed: false,
    closed: false,
    sockets: new Map(),
    lastOptions: null,
  };

  const io = {
    use: (fn) => state.middlewares.push(fn),
    on: (event, handler) => {
      if (event === 'connection') state.connectionHandlers.push(handler);
      return io;
    },
    adapter: (value) => {
      state.adapterSet = value;
    },
    disconnectSockets: () => {
      state.disconnected = true;
    },
    removeAllListeners: () => {
      state.removed = true;
    },
    // Present only to prove it is NEVER called during stop().
    close: () => {
      state.closed = true;
    },
    sockets: { sockets: state.sockets },
  };

  return { io, state };
};

const createFakeSocket = ({ auth = {} } = {}) => {
  const emitted = [];
  const handlers = {};

  return {
    handshake: { auth },
    data: {},
    emit: (event, payload) => emitted.push({ event, payload }),
    on: (event, handler) => {
      handlers[event] = handler;
    },
    emitted,
    handlers,
  };
};

const captureNext = () => {
  const calls = [];
  const next = (error) => calls.push(error);
  next.calls = calls;
  return next;
};

const fakeAdapter = () => {
  const handle = {
    adapter: { kind: 'fake-redis-adapter' },
    connected: false,
    closed: false,
    async connect() {
      handle.connected = true;
      return true;
    },
    async close() {
      handle.closed = true;
    },
  };
  return handle;
};

const USER_ID = '64b7f1c2a4e5d6f7a8b9c0d1';
const COMPANY_ID = '64b7f1c2a4e5d6f7a8b9c0d2';
const SESSION_ID = 'session-abc-123';

const validToken = (overrides = {}) =>
  jwt.sign(
    {
      sub: USER_ID,
      companyId: COMPANY_ID,
      tokenVersion: 0,
      sessionId: SESSION_ID,
      ...overrides,
    },
    env.JWT_SECRET,
  );

const fakeModels = ({
  user = { _id: USER_ID, companyId: COMPANY_ID, status: 'ACTIVE', role: 'COMPANY_ADMIN', tokenVersion: 0 },
  session = { sessionId: SESSION_ID },
} = {}) => ({
  UserModel: { findById: async () => user },
  SecuritySessionModel: { findOne: async () => session },
});

const buildGateway = (overrides = {}) => {
  const fake = createFakeIo();
  const adapter = fakeAdapter();

  const gateway = createSocketGateway({
    enabled: true,
    keyPrefix: 'crewly:test',
    redisAvailable: () => true,
    // Hermetic seam: a URL is required for the adapter to wire, and this
    // sandbox has no REDIS_URL. The real resolver is exercised separately.
    resolveRedisUrl: () => 'redis://127.0.0.1:6379',
    adapterBuilder: () => adapter,
    ioFactory: (server, options) => {
      fake.state.lastOptions = options;
      return fake.io;
    },
    log: { info: () => {}, warn: () => {} },
    verify: async () => ({
      ok: true,
      identity: { userId: USER_ID, companyId: COMPANY_ID, role: 'COMPANY_ADMIN', sessionId: SESSION_ID },
    }),
    ...overrides,
  });

  return { gateway, fake, adapter };
};

// ── 1. Enable flag + bounds ────────────────────────────────────────────────

describe('socketConfig — explicit enablement and code-owned bounds', () => {
  test('the enable flag is parsed explicitly, never as Boolean(env)', () => {
    assert.equal(parseSocketEnabled({ SOCKET_ENABLED: 'true' }), true);
    assert.equal(parseSocketEnabled({ SOCKET_ENABLED: 'TRUE' }), true);
    assert.equal(parseSocketEnabled({ SOCKET_ENABLED: ' true ' }), true);
    assert.equal(parseSocketEnabled({ SOCKET_ENABLED: 'false' }), false);
    assert.equal(parseSocketEnabled({ SOCKET_ENABLED: '1' }), false);
    assert.equal(parseSocketEnabled({ SOCKET_ENABLED: 'yes' }), false);
    assert.equal(parseSocketEnabled({}), false);
    assert.equal(parseSocketEnabled(undefined), false);
  });

  test('default is DISABLED unless explicitly enabled', () => {
    assert.equal(parseSocketEnabled(process.env), false);
  });

  test('safety bounds exist, are positive and are not operator-tunable', () => {
    assert.ok(SOCKET_MAX_PAYLOAD_BYTES > 0 && SOCKET_MAX_PAYLOAD_BYTES <= 64 * 1024);
    assert.ok(SOCKET_MAX_SOCKETS_PER_USER >= 1 && SOCKET_MAX_SOCKETS_PER_USER <= 10);
    assert.ok(SOCKET_MAX_SOCKETS_PER_PROCESS >= SOCKET_MAX_SOCKETS_PER_USER);
  });

  test('the adapter key is env-namespaced (crewly:<env>:chat)', () => {
    assert.equal(socketAdapterKey('crewly:development'), 'crewly:development:chat');
    assert.equal(socketAdapterKey('crewly:production'), 'crewly:production:chat');
    assert.notEqual(
      socketAdapterKey('crewly:staging'),
      socketAdapterKey('crewly:production'),
      'staging must never share a fan-out channel with production',
    );
  });
});

// ── 2. Event vocabulary ────────────────────────────────────────────────────

describe('socketProtocol — allowlist and bounded payloads', () => {
  test('vocabulary is infrastructure-only: no product families may exist yet', () => {
    assert.ok(SOCKET_EVENT_TYPES.length >= 1);
    assert.ok(
      SOCKET_EVENT_TYPES.every(
        (type) => !/^(chat|message|presence|typing|user|conversation):/.test(type),
      ),
    );
  });

  test('unknown event types are not allowed', () => {
    assert.equal(isAllowedSocketEventType('system:ping'), true);
    assert.equal(isAllowedSocketEventType('chat:message:send'), false);
    assert.equal(isAllowedSocketEventType('presence:update'), false);
    assert.equal(isAllowedSocketEventType(''), false);
    assert.equal(isAllowedSocketEventType(null), false);
  });

  test('parseSocketCommand drops malformed/unbounded frames instead of throwing', () => {
    assert.equal(parseSocketCommand(null), null);
    assert.equal(parseSocketCommand('string'), null);
    assert.equal(parseSocketCommand([]), null);
    assert.equal(parseSocketCommand({ type: 'chat:message:send', data: {} }), null);
    assert.equal(parseSocketCommand({ type: 'system:ping', data: [] }), null);

    const oversized = { blob: 'x'.repeat(SOCKET_MAX_PAYLOAD_BYTES + 100) };
    assert.equal(parseSocketCommand({ type: 'system:ping', data: oversized }), null);

    const ok = parseSocketCommand({ type: 'system:ping', data: { at: 1 } });
    assert.deepEqual(ok, { type: 'system:ping', data: { at: 1 } });

    // data is optional
    assert.deepEqual(parseSocketCommand({ type: 'system:ping' }), {
      type: 'system:ping',
      data: {},
    });
  });

  test('buildSocketFrame refuses unknown types and oversized payloads', () => {
    const frame = buildSocketFrame({ type: 'system:ping' });
    assert.equal(frame.type, 'system:ping');
    assert.ok(Number.isFinite(frame.ts));

    assert.throws(() => buildSocketFrame({ type: 'chat:message:send' }), /Unknown socket event type/);
    assert.throws(
      () => buildSocketFrame({ type: 'system:ping', data: { blob: 'x'.repeat(SOCKET_MAX_PAYLOAD_BYTES + 10) } }),
      /exceeds the .*byte bound/,
    );
  });
});

// ── 3. Registry bounds ─────────────────────────────────────────────────────

describe('socketRegistry — bounded, self-healing counters', () => {
  test('per-user cap is enforced and refusal is all-or-nothing', () => {
    const registry = createSocketRegistry({ maxPerUser: 2, maxPerProcess: 100 });

    assert.equal(registry.admit('u1').ok, true);
    assert.equal(registry.admit('u1').ok, true);

    const third = registry.admit('u1');
    assert.equal(third.ok, false);
    assert.equal(third.reason, 'USER_LIMIT');
    assert.equal(registry.countFor('u1'), 2, 'a refused socket must not be counted');
  });

  test('per-process cap is enforced across users', () => {
    const registry = createSocketRegistry({ maxPerUser: 5, maxPerProcess: 2 });

    registry.admit('u1');
    registry.admit('u2');

    const third = registry.admit('u3');
    assert.equal(third.ok, false);
    assert.equal(third.reason, 'PROCESS_LIMIT');
    assert.equal(registry.total(), 2);
  });

  test('release is idempotent and can never drive counts negative', () => {
    const registry = createSocketRegistry({ maxPerUser: 2, maxPerProcess: 10 });

    registry.admit('u1');
    registry.release('u1');
    registry.release('u1');
    registry.release('u1');

    assert.equal(registry.countFor('u1'), 0);
    assert.equal(registry.total(), 0);

    // A refused-but-released socket leaves capacity intact.
    assert.equal(registry.admit('u1').ok, true);
  });

  test('an identity-less socket is refused', () => {
    const registry = createSocketRegistry();
    const result = registry.admit(null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNKNOWN_IDENTITY');
  });
});

// ── 4. Handshake authentication ────────────────────────────────────────────

describe('socketAuth — tenant-only handshake identity', () => {
  const verify = (token, models = fakeModels()) =>
    verifySocketHandshake({
      token,
      jwtSecret: env.JWT_SECRET,
      UserModel: models.UserModel,
      SecuritySessionModel: models.SecuritySessionModel,
    });

  const expectRefusal = async (token, reason, models) => {
    const result = await verify(token, models);
    assert.equal(result.ok, false, `expected refusal ${reason}`);
    assert.equal(result.reason, reason);
    assert.equal(result.identity, undefined, 'a refusal never carries identity');
  };

  test('missing / non-string / blank token is refused', async () => {
    for (const token of [undefined, null, '', '   ', 42, {}]) {
      await expectRefusal(token, SOCKET_AUTH_REASONS.MISSING_TOKEN);
    }
  });

  test('a token signed with the wrong secret is refused', async () => {
    await expectRefusal(
      jwt.sign({ sub: USER_ID }, 'not-the-real-secret'),
      SOCKET_AUTH_REASONS.INVALID_TOKEN,
    );
  });

  test('an expired token is refused with its own reason', async () => {
    await expectRefusal(
      jwt.sign({ sub: USER_ID, sessionId: SESSION_ID, companyId: COMPANY_ID, tokenVersion: 0 }, env.JWT_SECRET, { expiresIn: '-1s' }),
      SOCKET_AUTH_REASONS.TOKEN_EXPIRED,
    );
  });

  test('a kiosk device token is refused — it proves a station, not a person', async () => {
    await expectRefusal(
      validToken({ scope: ['kiosk:session'], stationId: 'station-1' }),
      SOCKET_AUTH_REASONS.KIOSK_SCOPE,
    );
  });

  test('a BGV verifier principal is refused', async () => {
    await expectRefusal(
      validToken({ principalType: 'BGV_VERIFIER' }),
      SOCKET_AUTH_REASONS.VERIFIER_PRINCIPAL,
    );
  });

  test('a token with no subject is refused', async () => {
    await expectRefusal(
      jwt.sign({ companyId: COMPANY_ID }, env.JWT_SECRET),
      SOCKET_AUTH_REASONS.INVALID_SUBJECT,
    );
  });

  test('a deleted account is refused', async () => {
    await expectRefusal(validToken(), SOCKET_AUTH_REASONS.ACCOUNT_MISSING, fakeModels({ user: null }));
  });

  test('an inactive account is refused', async () => {
    await expectRefusal(
      validToken(),
      SOCKET_AUTH_REASONS.ACCOUNT_INACTIVE,
      fakeModels({
        user: { _id: USER_ID, companyId: COMPANY_ID, status: 'INACTIVE', tokenVersion: 0 },
      }),
    );
  });

  test('a platform principal (no companyId) is refused — chat is tenant-only', async () => {
    await expectRefusal(
      validToken(),
      SOCKET_AUTH_REASONS.NOT_TENANT_USER,
      fakeModels({
        user: { _id: USER_ID, companyId: null, status: 'ACTIVE', role: 'SUPER_ADMIN', tokenVersion: 0 },
      }),
    );
  });

  test('an old token without a session claim is refused', async () => {
    await expectRefusal(
      jwt.sign({ sub: USER_ID, companyId: COMPANY_ID, tokenVersion: 0 }, env.JWT_SECRET),
      SOCKET_AUTH_REASONS.SESSION_CLAIM_MISSING,
    );
  });

  test('a stale token (tokenVersion / companyId mismatch) is refused', async () => {
    await expectRefusal(
      validToken({ tokenVersion: 7 }),
      SOCKET_AUTH_REASONS.STALE_TOKEN,
    );

    await expectRefusal(
      validToken({ companyId: '64b7f1c2a4e5d6f7a8b9c0ff' }),
      SOCKET_AUTH_REASONS.STALE_TOKEN,
    );
  });

  test('a revoked / expired session is refused', async () => {
    await expectRefusal(validToken(), SOCKET_AUTH_REASONS.SESSION_EXPIRED, fakeModels({ session: null }));
  });

  test('a valid tenant token yields a server-derived identity', async () => {
    const result = await verify(validToken());

    assert.equal(result.ok, true);
    assert.equal(result.identity.userId, USER_ID);
    assert.equal(result.identity.companyId, COMPANY_ID);
    assert.equal(result.identity.role, 'COMPANY_ADMIN');
    assert.equal(result.identity.sessionId, SESSION_ID);
  });

  test('a "Bearer " prefix is tolerated for REST-client parity', async () => {
    const result = await verify(`Bearer ${validToken()}`);
    assert.equal(result.ok, true);
  });

  test('no failure path ever echoes the token back', async () => {
    const token = validToken({ scope: ['kiosk:session'] });
    const result = await verify(token);

    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(token));
  });
});

// ── 5. Gateway lifecycle ───────────────────────────────────────────────────

describe('socketGateway — lifecycle, options and degradation', () => {
  test('disabled by default: start() is a logged no-op and never builds a server', async () => {
    let built = false;
    const gateway = createSocketGateway({
      enabled: false,
      ioFactory: () => {
        built = true;
        return createFakeIo().io;
      },
      log: { info: () => {}, warn: () => {} },
    });

    const result = await gateway.start({});

    assert.deepEqual(result, { started: false, reason: 'DISABLED' });
    assert.equal(built, false);
    assert.equal(gateway.isStarted(), false);
    assert.equal(gateway.isAvailable(), false);
  });

  test('enabled but no http.Server: refuses to start rather than guessing a port', async () => {
    const gateway = createSocketGateway({
      enabled: true,
      log: { info: () => {}, warn: () => {} },
    });

    const result = await gateway.start(null);

    assert.equal(result.started, false);
    assert.equal(result.reason, 'NO_HTTP_SERVER');
  });

  test('attaches to the provided server with the no-cookie / websocket-only laws', async () => {
    const { gateway, fake } = buildGateway();

    await gateway.start({});

    const options = fake.state.lastOptions;

    assert.equal(options.cookie, false, 'cookies must never be written');
    assert.equal(options.serveClient, false);
    assert.deepEqual(options.transports, ['websocket'], 'polling needs sticky sessions');
    assert.equal(options.maxHttpBufferSize, SOCKET_MAX_PAYLOAD_BYTES);
    assert.ok(options.pingInterval > 0 && options.pingTimeout > 0);
  });

  test('CORS uses the SAME allowlist as the Express layer', async () => {
    const { gateway, fake } = buildGateway();

    await gateway.start({});

    const { origin } = fake.state.lastOptions.cors;

    const allowed = await new Promise((resolve) => origin(env.CLIENT_URL, (err, ok) => resolve({ err, ok })));
    assert.equal(allowed.err, null);
    assert.equal(allowed.ok, true);

    const refused = await new Promise((resolve) => origin('https://evil.example.com', (err) => resolve(err)));
    assert.ok(refused instanceof Error, 'an unknown origin must be refused');
    assert.match(refused.message, /not allowed by CORS/);
  });

  test('start() is idempotent', async () => {
    const { gateway } = buildGateway();

    const first = await gateway.start({});
    const second = await gateway.start({});

    assert.equal(first.started, true);
    assert.equal(second.reason, 'ALREADY_STARTED');
  });

  test('with Redis ready, the adapter is wired before any client can connect', async () => {
    const { gateway, fake, adapter } = buildGateway();

    const result = await gateway.start({});

    assert.equal(adapter.connected, true);
    assert.equal(fake.state.adapterSet, adapter.adapter);
    assert.equal(result.adapterReady, true);
    assert.equal(gateway.isAvailable(), true);
  });

  test('redis unavailable at start: gateway runs but REFUSES every handshake', async () => {
    const adapter = fakeAdapter();
    const { gateway, fake } = buildGateway({
      redisAvailable: () => false,
      adapterBuilder: () => adapter,
    });

    const result = await gateway.start({});

    assert.equal(result.started, true);
    assert.equal(result.adapterReady, false);
    assert.equal(adapter.connected, false, 'no adapter may be dialled while Redis is down');
    assert.equal(gateway.isAvailable(), false);

    const socket = createFakeSocket({ auth: { token: validToken() } });
    const next = captureNext();

    await fake.state.middlewares[0](socket, next);

    assert.equal(next.calls.length, 1);
    assert.equal(next.calls[0].data.code, SOCKET_ERROR_CODES.FEATURE_UNAVAILABLE);
  });

  test('redis going down mid-life stops NEW connections (checked per handshake)', async () => {
    let redisUp = true;
    const { gateway, fake } = buildGateway({ redisAvailable: () => redisUp });

    await gateway.start({});
    assert.equal(gateway.isAvailable(), true);

    redisUp = false;

    const socket = createFakeSocket({ auth: { token: validToken() } });
    const next = captureNext();

    await fake.state.middlewares[0](socket, next);

    assert.equal(next.calls[0].data.code, SOCKET_ERROR_CODES.FEATURE_UNAVAILABLE);
  });

  test('adapter wiring failure degrades to refusal, never a silent local-only chat', async () => {
    const { gateway } = buildGateway({
      adapterBuilder: () => ({
        adapter: {},
        connect: async () => {
          const error = new Error('boom');
          error.code = 'ECONNREFUSED';
          throw error;
        },
        close: async () => {},
      }),
    });

    const result = await gateway.start({});

    assert.equal(result.started, true);
    assert.equal(result.adapterReady, false);
    assert.equal(gateway.isAvailable(), false);
  });
});

// ── 6. Handshake pipeline + refusals ───────────────────────────────────────

describe('socketGateway — handshake pipeline', () => {
  test('an authenticated tenant socket is admitted and emits connection:ready', async () => {
    const { gateway, fake } = buildGateway();

    await gateway.start({});

    const socket = createFakeSocket({ auth: { token: validToken() } });
    const next = captureNext();

    await fake.state.middlewares[0](socket, next);

    assert.equal(next.calls.length, 1);
    assert.equal(next.calls[0], undefined, 'success is signalled by calling next() with no error');
    assert.equal(socket.data.identity.companyId, COMPANY_ID);

    fake.state.connectionHandlers[0](socket);

    const ready = socket.emitted.find((entry) => entry.event === 'connection:ready');
    assert.ok(ready, 'connection:ready must be emitted on connect');
    assert.ok(gateway.getRegistry().total() === 1);
  });

  test('a failed authentication sends ONE generic code and no detail', async () => {
    const { gateway, fake } = buildGateway({
      verify: async () => ({ ok: false, reason: 'stale_token' }),
    });

    await gateway.start({});

    const socket = createFakeSocket({ auth: { token: 'x' } });
    const next = captureNext();

    await fake.state.middlewares[0](socket, next);

    assert.equal(next.calls.length, 1);
    const error = next.calls[0];

    assert.equal(error.data.code, SOCKET_ERROR_CODES.UNAUTHORIZED);
    assert.deepEqual(Object.keys(error.data), ['code'], 'only a code may be exposed');
    assert.ok(!/stale_token/.test(error.message), 'the internal reason must not leak');
  });

  test('a kiosk token is refused end-to-end through the real verifier', async () => {
    const { gateway, fake } = buildGateway({
      verify: verifySocketHandshake,
      UserModel: fakeModels().UserModel,
      SecuritySessionModel: fakeModels().SecuritySessionModel,
    });

    await gateway.start({});

    const socket = createFakeSocket({
      auth: { token: validToken({ scope: ['kiosk:session'] }) },
    });
    const next = captureNext();

    await fake.state.middlewares[0](socket, next);

    assert.equal(next.calls[0].data.code, SOCKET_ERROR_CODES.UNAUTHORIZED);
  });

  test('capacity refusal is its own code (never an auth failure)', async () => {
    const registry = createSocketRegistry({ maxPerUser: 1, maxPerProcess: 10 });

    const { gateway, fake } = buildGateway({ registry });

    await gateway.start({});

    const first = createFakeSocket({ auth: { token: validToken() } });
    await fake.state.middlewares[0](first, captureNext());

    const second = createFakeSocket({ auth: { token: validToken() } });
    const next = captureNext();

    await fake.state.middlewares[0](second, next);

    assert.equal(next.calls[0].data.code, SOCKET_ERROR_CODES.CAPACITY);
  });

  test('system:ping echoes a bounded frame; malformed frames are ignored', async () => {
    const { gateway, fake } = buildGateway();

    await gateway.start({});

    const socket = createFakeSocket({ auth: { token: validToken() } });
    await fake.state.middlewares[0](socket, captureNext());
    fake.state.connectionHandlers[0](socket);

    const acks = [];

    socket.handlers['system:ping']({ type: 'system:ping', data: {} }, (frame) => acks.push(frame));
    assert.equal(acks.length, 1);
    assert.equal(acks[0].type, 'system:ping');

    // Unknown + oversized commands are dropped without acking or throwing.
    socket.handlers['system:ping']({ type: 'chat:message:send', data: {} }, (frame) => acks.push(frame));
    socket.handlers['system:ping'](
      { type: 'system:ping', data: { blob: 'x'.repeat(SOCKET_MAX_PAYLOAD_BYTES + 10) } },
      (frame) => acks.push(frame),
    );

    assert.equal(acks.length, 1, 'only the valid command may be answered');
  });

  test('disconnect releases the registry slot (no leak on reconnect churn)', async () => {
    const { gateway, fake } = buildGateway();

    await gateway.start({});

    const socket = createFakeSocket({ auth: { token: validToken() } });
    await fake.state.middlewares[0](socket, captureNext());
    fake.state.connectionHandlers[0](socket);

    assert.equal(gateway.getRegistry().total(), 1);

    socket.handlers.disconnect();

    assert.equal(gateway.getRegistry().total(), 0);
  });
});

// ── 7. Shutdown law ────────────────────────────────────────────────────────

describe('socketGateway — stop() semantics', () => {
  test('stop() disconnects clients, closes the adapter and NEVER closes the http.Server', async () => {
    const { gateway, fake, adapter } = buildGateway();

    await gateway.start({});

    const result = await gateway.stop();

    assert.equal(fake.state.disconnected, true, 'live sockets must be dropped');
    assert.equal(adapter.closed, true, 'adapter connections must be released');
    assert.equal(fake.state.closed, false, 'io.close() would close the http.Server and pre-empt 32.2 shutdown');
    assert.equal(gateway.isStarted(), false);
    assert.equal(gateway.getRegistry().total(), 0);
  });

  test('stop() is safe before start and safe twice', async () => {
    const { gateway } = buildGateway();

    const before = await gateway.stop();
    assert.equal(before.stopped, false);

    await gateway.start({});
    await gateway.stop();
    const again = await gateway.stop();

    assert.equal(again.stopped, false);
  });

  test('after stop(), a new handshake is refused because the gateway is no longer available', async () => {
    const { gateway, fake } = buildGateway();

    await gateway.start({});
    await gateway.stop();

    const socket = createFakeSocket({ auth: { token: validToken() } });
    const next = captureNext();

    await fake.state.middlewares[0](socket, next);

    assert.equal(next.calls[0].data.code, SOCKET_ERROR_CODES.FEATURE_UNAVAILABLE);
  });
});
