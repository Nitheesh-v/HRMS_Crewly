// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE SOCKET FACTORY TESTS (hermetic)
//
//  Covers §41 backend tests #36–#42.
//  We never instantiate a real Socket.IO server here. The factory
//  is a black box that takes the wiring as parameters (enabled,
//  source, verify, registerHandlers, createAdapterClients, log). We
//  inject a fake adapter that says "Redis is up" or "Redis is down"
//  and assert the factory's return shape.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Set env BEFORE any module-level import of env.js happens.
process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_socket_test';

const here = path.dirname(fileURLToPath(import.meta.url));

const { createPresenceSocketServer, buildPresenceSocketOptions } = await import(
  '../src/socket/presenceSocket.js'
);
const {
  isPresenceOriginAllowed,
  PRESENCE_NAMESPACE,
  PRESENCE_SOCKET_PATH,
  PRESENCE_FEATURE_UNAVAILABLE,
  parsePresenceSocketEnabled,
  presenceAdapterKey,
  PRESENCE_MAX_HTTP_BUFFER_BYTES,
  PRESENCE_PING_INTERVAL_MS,
  PRESENCE_PING_TIMEOUT_MS,
  PRESENCE_CONNECT_TIMEOUT_MS,
} = await import('../src/socket/presenceSocketConfig.js');

const baseLog = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
});

const baseHandlerReg = () => ({ onUnbind: () => {} });

// A fake Socket.IO instance that mirrors Socket.IO's API: a Namespace
// owns an adapter instance, while Server.adapter() is the setter API.
const fakeIo = () => {
  const calls = { adapter: [], engineClose: 0, namespaceMiddleware: [], namespaceEvents: [], rootMiddleware: [] };
  const fakeNamespace = {
    use: (middleware) => calls.namespaceMiddleware.push(middleware),
    on: (event, handler) => calls.namespaceEvents.push({ event, handler }),
    adapter: { close: async () => {} },
    disconnectSockets: () => 0,
  };
  const fakeServer = {
    of: () => fakeNamespace,
    use: (middleware) => calls.rootMiddleware.push(middleware),
    engine: { close: () => { calls.engineClose += 1; } },
  };
  return { server: fakeServer, calls, namespace: fakeNamespace };
};

const { createServer } = await import('node:http');
const fakeHttp = () => {
  // A real (but unlistened) http.Server — Socket.IO's
  // Server.prototype.attach calls server.listeners which the
  // minimal stub does not provide. We never call .listen() in
  // these tests; the factory only inspects the http server.
  return createServer(() => {});
};

const fakeRedis = () => ({
  // Minimal surface needed by createPresenceLiveStore (we never
  // actually call methods in these tests because the adapter
  // is the only thing under test, and when the adapter fails
  // the store is also instantiated but the test never invokes
  // store methods).
  __fake: true,
});

test('socket: factory refuses to start when PRESENCE_SOCKET_ENABLED!=true', async () => {
  const server = createPresenceSocketServer({
    enabled: false,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'false' },
    verify: () => ({ ok: true, userId: 'u1', companyId: 'c1', sessionId: 's1' }),
    registerHandlers: baseHandlerReg(),
    createAdapterClients: async () => ({ ok: true, key: 'k', adapter: () => ({ close: async () => {} }), close: async () => {} }),
    log: baseLog(),
  });
  const result = await server.attach(fakeHttp(), { sharedRedis: fakeRedis() });
  assert.equal(result.started, false);
  assert.equal(result.reason, 'DISABLED');
});

test('#36 socket: factory refuses as FEATURE_UNAVAILABLE when Redis adapter is down', async () => {
  const io = fakeIo();
  const server = createPresenceSocketServer({
    enabled: true,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'true' },
    verify: () => ({ ok: true, userId: 'u1', companyId: 'c1', sessionId: 's1' }),
    registerHandlers: baseHandlerReg(),
    createAdapterClients: async () => ({ ok: false, reason: 'REDIS_DOWN' }),
    log: baseLog(),
  });
  const result = await server.attach(fakeHttp(), {
    sharedIo: io.server,
    sharedRedis: fakeRedis(),
  });
  assert.equal(result.started, false);
  assert.equal(result.reason, 'FEATURE_UNAVAILABLE');
  assert.equal(io.calls.namespaceMiddleware.length, 1);
  const refusal = await new Promise((resolve) => {
    io.calls.namespaceMiddleware[0]({}, (error) => resolve(error));
  });
  assert.equal(refusal?.data?.code, 'FEATURE_UNAVAILABLE');
  await server.stop();
  assert.equal(io.calls.engineClose, 0, 'presence stop must not close chat shared Engine.IO');
});

test('socket: a dedicated adapter-construction failure fails closed without affecting shared chat IO', async () => {
  const io = fakeIo();
  let closeCount = 0;
  const server = createPresenceSocketServer({
    enabled: true,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'true' },
    createAdapterClients: async () => ({
      ok: true,
      key: 'k',
      adapter: () => { throw new Error('ADAPTER_INIT_FAILED'); },
      close: async () => { closeCount += 1; },
    }),
    log: baseLog(),
  });
  const result = await server.attach(fakeHttp(), {
    sharedIo: io.server,
    sharedRedis: fakeRedis(),
  });
  assert.equal(result.started, false);
  assert.equal(result.reason, 'FEATURE_UNAVAILABLE');
  assert.equal(closeCount, 1, 'failed adapter clients are cleaned up');
  const refusal = await new Promise((resolve) => {
    io.calls.namespaceMiddleware[0]({}, (error) => resolve(error));
  });
  assert.equal(refusal?.data?.code, 'FEATURE_UNAVAILABLE');
  await server.stop();
  assert.equal(io.calls.engineClose, 0, 'presence must not close shared chat IO');
});

test('socket: missing shared Redis degrades to FEATURE_UNAVAILABLE without throwing', async () => {
  const io = fakeIo();
  let adapterCalls = 0;
  const server = createPresenceSocketServer({
    enabled: true,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'true' },
    createServer: () => io.server,
    getRedisClientFn: () => null,
    createAdapterClients: async () => {
      adapterCalls += 1;
      return { ok: true, key: 'k', adapter: () => ({ close: async () => {} }), close: async () => {} };
    },
    log: baseLog(),
  });
  const result = await server.attach(fakeHttp());
  assert.equal(result.started, false);
  assert.equal(result.reason, 'FEATURE_UNAVAILABLE');
  assert.equal(adapterCalls, 0);
  const refusal = await new Promise((resolve) => {
    io.calls.namespaceMiddleware[0]({}, (error) => resolve(error));
  });
  assert.equal(refusal?.data?.code, 'FEATURE_UNAVAILABLE');
  await server.stop();
  assert.equal(io.calls.engineClose, 1, 'presence closes only its owned Engine.IO server');
});

test('#37 socket: factory accepts and wires the adapter when Redis is up', async () => {
  const io = fakeIo();
  let closeCount = 0;
  const server = createPresenceSocketServer({
    enabled: true,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'true' },
    verify: () => ({ ok: true, userId: 'u1', companyId: 'c1', sessionId: 's1' }),
    registerHandlers: baseHandlerReg(),
    createAdapterClients: async () => {
      closeCount += 1;
      return {
        ok: true,
        key: 'crewly:development:presence:adapter',
        adapter: (namespace) => {
          const instance = { namespace, close: async () => {} };
          io.calls.adapter.push(instance);
          return instance;
        },
        close: async () => { closeCount += 1; },
      };
    },
    log: baseLog(),
  });
  const result = await server.attach(fakeHttp(), { sharedIo: io.server, sharedRedis: fakeRedis() });
  assert.equal(result.started, true);
  assert.equal(result.namespace, PRESENCE_NAMESPACE);
  assert.equal(result.path, PRESENCE_SOCKET_PATH);
  assert.equal(io.calls.adapter.length, 1);
  assert.equal(io.calls.adapter[0].namespace, io.namespace);
  assert.equal(io.namespace.adapter, io.calls.adapter[0]);
  // Adapter was closed during stop()
  await server.stop();
  assert.equal(closeCount >= 2, true);
});

test('socket: presence owns Engine.IO when chat has not created a shared Socket.IO server', async () => {
  const io = fakeIo();
  const server = createPresenceSocketServer({
    enabled: true,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'true' },
    createServer: (_httpServer, options) => {
      assert.equal(options.path, PRESENCE_SOCKET_PATH);
      return io.server;
    },
    getRedisClientFn: () => fakeRedis(),
    createAdapterClients: async () => ({
      ok: true,
      key: 'presence-only-key',
      adapter: (namespace) => {
        const instance = { namespace, close: async () => {} };
        io.calls.adapter.push(instance);
        return instance;
      },
      close: async () => {},
    }),
    log: baseLog(),
  });

  const result = await server.attach(fakeHttp());
  assert.equal(result.started, true);
  assert.equal(io.calls.rootMiddleware.length, 1, 'the unused root namespace is closed');
  assert.equal(io.namespace.adapter, io.calls.adapter[0]);
  await server.stop();
  assert.equal(io.calls.engineClose, 1, 'presence closes only its owned Engine.IO server');
});

test('socket: stop() is safe to call even when nothing was attached', async () => {
  const server = createPresenceSocketServer({
    enabled: true,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'true' },
    verify: () => ({ ok: true, userId: 'u1', companyId: 'c1', sessionId: 's1' }),
    registerHandlers: baseHandlerReg(),
    createAdapterClients: async () => ({ ok: false, reason: 'X' }),
    log: baseLog(),
  });
  await server.attach(fakeHttp(), { sharedRedis: fakeRedis() }); // refused
  const stop = await server.stop();
  assert.equal(stop.stopped, true);
});

test('#38 origin gate: isPresenceOriginAllowed() honors CHAT_ALLOW_LOCALHOST_ORIGINS', () => {
  const source = { ...process.env, CHAT_ALLOW_LOCALHOST_ORIGINS: 'true' };
  assert.equal(isPresenceOriginAllowed('http://localhost:5173', source), true);
  assert.equal(isPresenceOriginAllowed('http://127.0.0.1:3000', source), true);
  assert.equal(isPresenceOriginAllowed('http://example.com', source), false);
});

test('origin gate: prod (NODE_ENV=production) refuses loopback without flag', () => {
  const source = {
    ...process.env,
    NODE_ENV: 'production',
    CHAT_ALLOW_LOCALHOST_ORIGINS: 'false',
    CLIENT_URL: 'https://app.crewly.io',
  };
  assert.equal(isPresenceOriginAllowed('http://localhost:5173', source), false);
  assert.equal(isPresenceOriginAllowed('https://app.crewly.io', source), true);
});

test('origin gate: dev preview origin (e2b.app) is allowed in dev', () => {
  const source = {
    ...process.env,
    NODE_ENV: 'development',
    CHAT_ALLOW_LOCALHOST_ORIGINS: 'false',
    CLIENT_URL: '',
  };
  assert.equal(
    isPresenceOriginAllowed('https://12345-abcdef.e2b.app', source),
    true,
  );
  assert.equal(isPresenceOriginAllowed('https://example.com', source), false);
});

test('socket options: CORS origin callback enforces the presence allowlist', async () => {
  const source = {
    ...process.env,
    NODE_ENV: 'production',
    CLIENT_URL: 'https://app.crewly.io',
    CHAT_ALLOW_LOCALHOST_ORIGINS: 'false',
  };
  const options = buildPresenceSocketOptions({ source });
  const checkOrigin = (origin) => new Promise((resolve, reject) => {
    options.cors.origin(origin, (error, allowed) => {
      if (error) return reject(error);
      resolve(allowed);
    });
  });
  assert.equal(await checkOrigin('https://app.crewly.io'), true);
  assert.equal(await checkOrigin('https://evil.example'), false);
});

test('config: presenceAdapterKey() env-namespaces the adapter channel', () => {
  assert.equal(
    presenceAdapterKey('crewly:staging'),
    'crewly:staging:presence:adapter',
  );
  assert.equal(
    presenceAdapterKey('crewly:production'),
    'crewly:production:presence:adapter',
  );
});

test('config: PRESENCE_FEATURE_UNAVAILABLE is the generic contract', () => {
  assert.equal(PRESENCE_FEATURE_UNAVAILABLE.code, 'FEATURE_UNAVAILABLE');
  assert.equal(typeof PRESENCE_FEATURE_UNAVAILABLE.message, 'string');
});

test('config: parsePresenceSocketEnabled() defaults to false', () => {
  assert.equal(parsePresenceSocketEnabled({}), false);
  assert.equal(parsePresenceSocketEnabled({ PRESENCE_SOCKET_ENABLED: 'true' }), true);
  assert.equal(parsePresenceSocketEnabled({ PRESENCE_SOCKET_ENABLED: 'TRUE' }), true);
  assert.equal(parsePresenceSocketEnabled({ PRESENCE_SOCKET_ENABLED: ' yes ' }), false);
  assert.equal(parsePresenceSocketEnabled({ PRESENCE_SOCKET_ENABLED: 'false' }), false);
});

test('config: bounded frame size is much smaller than the EIO default', () => {
  // EIO default is 1 MB; we want presence frames to be tiny.
  assert.ok(PRESENCE_MAX_HTTP_BUFFER_BYTES <= 8 * 1024);
  assert.ok(PRESENCE_PING_INTERVAL_MS > 0);
  assert.ok(PRESENCE_PING_TIMEOUT_MS > 0);
  assert.ok(PRESENCE_CONNECT_TIMEOUT_MS > 0);
});

test('#39 socket: namespace isolation — presence at "/presence", chat at "/"', () => {
  assert.equal(PRESENCE_NAMESPACE, '/presence');
  // Chat lives at the Socket.IO default '/'. Different paths.
  assert.notEqual(PRESENCE_NAMESPACE, '/');
});

test('#40 socket: source-pin — no attendance/leave/payroll/AI/localStorage anywhere in src/socket/presenceSocket*.js', () => {
  const files = [
    'src/socket/presenceSocket.js',
    'src/socket/presenceSocketConfig.js',
    'src/socket/presenceSocketHandlers.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(here, '..', f), 'utf8');
    // Strip comments first so anti-attendance declarations don't
    // false-positive. The presenceSocketHandlers.js comment
    // *enumerates* the bans; that's allowed.
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\battendance\b/i.test(noLine), false, `${f} references attendance`);
    assert.equal(/\bleave\b/i.test(noLine), false, `${f} references leave`);
    assert.equal(/\bpayroll\b/i.test(noLine), false, `${f} references payroll`);
    assert.equal(/\bopenai\b|\banthropic\b|\bclaude\b|\bgpt\b|\bllm\b/i.test(noLine), false, `${f} references AI`);
    assert.equal(/localStorage|sessionStorage|document\.cookie/i.test(noLine), false, `${f} references browser storage`);
  }
});

test('#41 socket: source-pin — no FLUSH*/KEYS/SCAN from presenceSocketHandlers.js', () => {
  const src = fs.readFileSync(
    path.join(here, '..', 'src', 'socket', 'presenceSocketHandlers.js'),
    'utf8',
  );
  assert.equal(/\bFLUSHALL\b/.test(src), false);
  assert.equal(/\bFLUSHDB\b/.test(src), false);
  assert.equal(/redis\.keys\s*\(/i.test(src), false);
  assert.equal(/redis\.scan\s*\(/i.test(src), false);
  assert.equal(/\.scan\s*\(/i.test(src), false);
});

test('#42 socket: source-pin — handlers do NOT import the AI module', () => {
  const src = fs.readFileSync(
    path.join(here, '..', 'src', 'socket', 'presenceSocketHandlers.js'),
    'utf8',
  );
  assert.equal(/presenceAI|presenceAi|openai|anthropic|claude/i.test(src), false);
});

test('socket: factory never throws when attach() is called twice', async () => {
  const io = fakeIo();
  const server = createPresenceSocketServer({
    enabled: true,
    source: { ...process.env, PRESENCE_SOCKET_ENABLED: 'true' },
    verify: () => ({ ok: true, userId: 'u1', companyId: 'c1', sessionId: 's1' }),
    registerHandlers: baseHandlerReg(),
    createAdapterClients: async () => ({
      ok: true,
      key: 'k',
      adapter: () => ({ close: async () => {} }),
      close: async () => {},
    }),
    log: baseLog(),
  });
  const r1 = await server.attach(fakeHttp(), { sharedIo: io.server, sharedRedis: fakeRedis() });
  // Second attach — idempotent / safe.
  const r2 = await server.attach(fakeHttp(), { sharedIo: io.server, sharedRedis: fakeRedis() });
  assert.equal(r1.started, true);
  assert.equal(r2.started, true);
  await server.stop();
});

// Phase 37.7 — presence:tick handler (read-only re-eval). The
// handler re-resolves using the EXISTING live snapshot and publishes
// ONLY if the memo'd value differs. It does NOT call recordActivity
// or refreshHeartbeat (the user did not signal new activity; they
// just asked the server to re-run the resolver).
test('#43 socket: presence:tick handler is read-only — no recordActivity / no refreshHeartbeat', () => {
  const src = fs.readFileSync(
    path.join(here, '..', 'src', 'socket', 'presenceSocketHandlers.js'),
    'utf8',
  );
  // The tick block must exist.
  assert.match(src, /presence:tick/);
  // The tick block must NOT call recordActivity or refreshHeartbeat.
  // Find the tick block by slicing between presence:tick and the
  // next `socket.on(` (or end-of-handlers) and assert that it has no
  // store-mutating calls.
  const tickMatch = src.match(/socket\.on\(\s*['"]presence:tick['"][\s\S]*?(?=socket\.on\(\s*['"]disconnect)/);
  assert.ok(tickMatch, 'presence:tick handler block is present');
  const block = tickMatch[0];
  assert.equal(
    /recordActivity|refreshHeartbeat/.test(block),
    false,
    'presence:tick must NOT mutate the live store (read-only re-eval).',
  );
  // The tick block must publish — that is the whole point.
  assert.match(block, /publishIfChanged/);
  // And it must use source: 'tick' so consumers can trace.
  assert.match(block, /['"]tick['"]/);
});

test('server: presence socket is opt-in, shares chat IO, attaches before listen, and drains first', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /parsePresenceSocketEnabled\(\)/);
  assert.match(src, /getPresenceSocketServer/);
  assert.match(src, /sharedIo:\s*getChatSocketServer\(\)\.getIo\(\)/);
  const presenceAttach = src.indexOf('presenceSocketServer.attach(server');
  const listen = src.indexOf('server.listen(');
  assert.ok(presenceAttach >= 0 && presenceAttach < listen, 'presence attaches before listen');
  const presenceStop = src.indexOf('presenceSocketServer?.stop()');
  const chatStop = src.indexOf('getChatSocketServer().stop()');
  assert.ok(presenceStop >= 0 && presenceStop < chatStop, 'presence namespace drains before shared chat IO');
});

test('#44 socket: PRESENCE_SOCKET_INBOUND_EVENTS includes presence:tick', async () => {
  const { PRESENCE_SOCKET_INBOUND_EVENTS } = await import(
    '../src/services/presence/presenceEvents.js'
  );
  assert.ok(
    PRESENCE_SOCKET_INBOUND_EVENTS.includes('presence:tick'),
    'PRESENCE_SOCKET_INBOUND_EVENTS must include presence:tick (Phase 37.7 §C.3).',
  );
  // Also pinned in the handler — the handler registry must accept
  // the event so a stray emit is silently dropped, not undefined.
  const handlersSrc = fs.readFileSync(
    path.join(here, '..', 'src', 'socket', 'presenceSocketHandlers.js'),
    'utf8',
  );
  assert.match(handlersSrc, /socket\.on\(\s*['"]presence:tick['"]/);
});
