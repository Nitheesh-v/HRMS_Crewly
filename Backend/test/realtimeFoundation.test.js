// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — REALTIME FOUNDATION (hermetic, §65/§76–§83)
//
// Two LOGICAL realtime instances on a shared in-memory pub/sub bus prove
// cross-instance fan-out + tenant isolation without any live Redis (the
// sanctioned §65 pattern). Real ioredis connections share the primitives
// already proven in 32.6/32.7; live-Redis fanout can be validated on
// localhost with REALTIME_ENABLED=true.
//
// Laws pinned here: server-derived identity only · single-use tickets ·
// allowlisted bounded protocol · heartbeat ≠ employee Presence · bounded
// drain · Redis-down degradation · no product vocabulary.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/realtime-foundation';

const { parseRealtimeEnabled, realtimeChannelName, realtimeTicketKey, REALTIME_EVENT_TYPES } = await import(
  '../src/infrastructure/realtime/realtimeConfig.js'
);
const { createRealtimeRegistry } = await import('../src/infrastructure/realtime/realtimeRegistry.js');
const { createRealtimeTickets, isValidTicketShape } = await import('../src/infrastructure/realtime/realtimeTickets.js');
const { buildRealtimeEnvelope, parseRealtimeEnvelope, formatSseFrame, SSE_HEARTBEAT_FRAME } = await import(
  '../src/infrastructure/realtime/realtimeProtocol.js'
);
const { createRealtimeGateway } = await import('../src/infrastructure/realtime/realtimeGateway.js');

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A1 = 'cccccccccccccccccccccccc';
const USER_A2 = 'dddddddddddddddddddddddd';
const USER_B1 = 'eeeeeeeeeeeeeeeeeeeeeeee';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createMockRes = () => {
  const res = {
    writes: [],
    statusCode: null,
    ended: false,
    closeHandler: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    set() {
      return res;
    },
    flushHeaders() {},
    on(event, handler) {
      if (event === 'close') res.closeHandler = handler;
      return res;
    },
    write(frame) {
      if (res.ended) return false;
      res.writes.push(frame);
      return true;
    },
    end() {
      res.ended = true;
      res.closeHandler?.();
    },
  };
  return res;
};

const sleep0 = async () => sleep(0);

// ── in-memory pub/sub bus (the shared fan-out fabric for two instances) ──
const createMemoryBus = () => {
  const subscribers = [];
  return {
    subscriberCount: () => subscribers.length,
    /** Live message handlers registered by gateways (frame-injection seam). */
    registeredHandlers: () => subscribers.map((sub) => sub.handler).filter(Boolean),
    makePublisher: () => ({
      publish: async (_channel, raw) => {
        for (const sub of [...subscribers]) sub.handler?.(_channel, raw);
        return subscribers.length;
      },
      quit: async () => {},
    }),
    makeSubscriber: () => {
      const sub = {
        handler: null,
        on(_event, handler) {
          sub.handler = handler;
        },
        subscribe: async () => {
          subscribers.push(sub);
        },
        quit: async () => {
          const index = subscribers.indexOf(sub);
          if (index >= 0) subscribers.splice(index, 1);
        },
      };
      return sub;
    },
  };
};

// ── fake shared Redis for the ticket store (MULTI get+del semantics) ──
const createFakeRedis = () => {
  const store = new Map();
  return {
    store,
    async set(key, value, _mode, ttl) {
      store.set(key, { value, ttl });
      return 'OK';
    },
    multi() {
      const commands = [];
      return {
        get(key) {
          commands.push(['get', key]);
          return this;
        },
        del(key) {
          commands.push(['del', key]);
          return this;
        },
        async exec() {
          return commands.map(([op, key]) => {
            if (op === 'get') {
              const entry = store.get(key) || null;
              store.delete(key);
              return [null, entry ? entry.value : null];
            }
            store.delete(key);
            return [null, 1];
          });
        },
      };
    },
  };
};

const startGateway = async ({ bus, extra = {} } = {}) => {
  const gateway = createRealtimeGateway({
    enabled: true,
    channel: realtimeChannelName('crewly:test'),
    heartbeatMs: 10,
    publisher: bus?.makePublisher(),
    subscriber: bus?.makeSubscriber(),
    ...extra,
  });
  const startResult = await gateway.start();
  assert.equal(startResult.started, true, 'test gateway must actually start (pub/sub + heartbeat live)');
  return gateway;
};

// ═══════════════════════════════════════════════════════════════════
describe('realtime config (explicit parsing + namespacing)', () => {
  test('REALTIME_ENABLED parses explicitly; default is DISABLED', () => {
    assert.equal(parseRealtimeEnabled({}), false);
    assert.equal(parseRealtimeEnabled({ REALTIME_ENABLED: 'true' }), true);
    assert.equal(parseRealtimeEnabled({ REALTIME_ENABLED: 'TRUE' }), true);
    assert.equal(parseRealtimeEnabled({ REALTIME_ENABLED: '1' }), false, 'not Boolean(env) — exact true only');
    assert.equal(parseRealtimeEnabled({ REALTIME_ENABLED: 'garbage' }), false);
  });

  test('channel + ticket keys are env-namespaced; channels never carry identities', () => {
    assert.equal(realtimeChannelName('crewly:development'), 'crewly:development:realtime:events');
    const key = realtimeTicketKey('crewly:test', 'f'.repeat(64));
    assert.ok(key.startsWith('crewly:test:realtime:ticket:'));
    assert.equal(realtimeEventVocabularySafe(), true);
  });

  const realtimeEventVocabularySafe = () =>
    REALTIME_EVENT_TYPES.every((type) => !/^(message|presence|typing|chat|user):/.test(type));
});

describe('realtime registry (bounded process-local ownership)', () => {
  test('admit → deliver-by-tenant → remove on close', () => {
    const registry = createRealtimeRegistry();
    const res = createMockRes();
    const { ok, stream } = registry.add({ companyId: COMPANY_A, userId: USER_A1, res });

    assert.equal(ok, true);
    assert.equal(registry.byCompany(COMPANY_A).length, 1);
    assert.equal(registry.byCompany(COMPANY_B).length, 0);

    registry.remove(stream.id);
    assert.equal(registry.size(), 0);
    assert.equal(res.ended, false, 'removal is bookkeeping — ending the response is the drain/gateway job');
  });

  test('per-user stream cap and per-process cap are enforced (bounded, §31/§59)', () => {
    const registry = createRealtimeRegistry({ maxStreams: 3, maxPerUser: 2 });

    assert.equal(registry.add({ companyId: COMPANY_A, userId: USER_A1, res: createMockRes() }).ok, true);
    assert.equal(registry.add({ companyId: COMPANY_A, userId: USER_A1, res: createMockRes() }).ok, true);
    assert.equal(registry.add({ companyId: COMPANY_A, userId: USER_A1, res: createMockRes() }).ok, false, 'user cap');

    assert.equal(registry.add({ companyId: COMPANY_A, userId: USER_A2, res: createMockRes() }).ok, true);

    // Process cap reached (3/3): any further stream is refused — regardless of tenant/user.
    assert.equal(registry.add({ companyId: COMPANY_B, userId: USER_B1, res: createMockRes() }).ok, false, 'process cap');
    assert.equal(registry.add({ companyId: COMPANY_A, userId: USER_A2, res: createMockRes() }).ok, false, 'process cap');

    // Removal is bookkeeping that frees real capacity (bounded, never leaks).
    const freed = registry.describe().find((s) => s.companyId === COMPANY_A && s.userId === USER_A1);
    registry.remove(freed.id);
    assert.equal(registry.add({ companyId: COMPANY_B, userId: USER_B1, res: createMockRes() }).ok, true, 'removal frees capacity');
  });

  test('clear() drains everything (bounded shutdown primitive)', () => {
    const registry = createRealtimeRegistry();
    registry.add({ companyId: COMPANY_A, userId: USER_A1, res: createMockRes() });
    registry.add({ companyId: COMPANY_B, userId: USER_B1, res: createMockRes() });
    assert.equal(registry.clear().length, 2);
    assert.equal(registry.size(), 0);
  });
});

describe('realtime protocol (allowlisted, bounded, safe framing)', () => {
  test('valid envelope builds with id/ts and passes the delivery boundary', () => {
    const envelope = buildRealtimeEnvelope({ type: 'realtime:proof', companyId: COMPANY_A, payload: { hello: 'world' } });

    assert.equal(envelope.type, 'realtime:proof');
    assert.equal(envelope.companyId, COMPANY_A);
    assert.equal(envelope.userId, null);
    assert.ok(envelope.id && envelope.ts);

    const round = parseRealtimeEnvelope(JSON.stringify(envelope));
    assert.deepEqual({ ...round, ts: envelope.ts, id: envelope.id }, envelope);
  });

  test('product vocabulary and unknown types are REFUSED at publish and ignored at delivery', () => {
    for (const bad of ['message:new', 'presence:update', 'typing:start', 'user:away', 'system:pwn']) {
      assert.throws(() => buildRealtimeEnvelope({ type: bad, companyId: COMPANY_A }), /Unknown realtime event type/);
      assert.equal(parseRealtimeEnvelope(JSON.stringify({ type: bad, companyId: COMPANY_A, payload: {} })), null);
    }
  });

  test('oversized payloads are refused (4 KB envelope bound)', () => {
    assert.throws(
      () => buildRealtimeEnvelope({ type: 'system:ping', companyId: COMPANY_A, payload: { blob: 'x'.repeat(5000) } }),
      /bound/
    );
    assert.equal(parseRealtimeEnvelope(JSON.stringify({ type: 'system:ping', companyId: COMPANY_A, payload: { blob: 'x'.repeat(5000) } })), null);
  });

  test('malformed frames never throw at the delivery boundary', () => {
    assert.equal(parseRealtimeEnvelope('not json'), null);
    assert.equal(parseRealtimeEnvelope('[1,2,3]'), null);
    assert.equal(parseRealtimeEnvelope(JSON.stringify({ type: 'system:ping', companyId: 'short', payload: {} })), null);
  });

  test('SSE framing carries event name + id + data; heartbeat is a comment', () => {
    const envelope = buildRealtimeEnvelope({ type: 'connection:ready', companyId: COMPANY_A, userId: USER_A1, payload: {} });
    const frame = formatSseFrame(envelope);
    assert.ok(frame.startsWith('event: connection:ready\n'));
    assert.ok(frame.includes(`id: ${envelope.id}\n`));
    assert.ok(frame.endsWith('\n\n'));
    assert.equal(SSE_HEARTBEAT_FRAME, ':hb\n\n');
  });
});

describe('one-time tickets (shared store, single-use, fail-closed)', () => {
  test('issue → consume roundtrip binds the VERIFIED identity once', async () => {
    const redis = createFakeRedis();
    const tickets = createRealtimeTickets({ redis, prefix: 'crewly:test' });

    const { ticket, expiresInSeconds } = await tickets.issue({ userId: USER_A1, companyId: COMPANY_A });
    assert.ok(isValidTicketShape(ticket));
    assert.equal(expiresInSeconds, 30);
    assert.equal(redis.store.get(realtimeTicketKey('crewly:test', ticket)).ttl, 30, 'TTL is enforced at the store');

    assert.deepEqual(await tickets.consume(ticket), { userId: USER_A1, companyId: COMPANY_A });
    assert.equal(await tickets.consume(ticket), null, 'single-use: replay is refused');
  });

  test('malformed ticket shapes are refused WITHOUT touching the store', async () => {
    const redis = createFakeRedis();
    const tickets = createRealtimeTickets({ redis, prefix: 'crewly:test' });

    for (const bad of [undefined, null, '', '../../../etc/passwd', 'ZZ'.repeat(32), `${'a'.repeat(63)}`]) {
      assert.equal(await tickets.consume(bad), null);
    }
    assert.equal(redis.store.size, 0);
  });

  test('shared-store failure fails CLOSED (no stream, no leak)', async () => {
    const tickets = createRealtimeTickets({
      redis: { multi: () => ({ get() { return this; }, del() { return this; }, exec: async () => { throw new Error('down'); } }) },
      prefix: 'crewly:test',
    });
    assert.equal(await tickets.consume(isValidTicketShape('a'.repeat(64)) ? 'a'.repeat(64) : null), null);
  });
});

describe('gateway + TWO logical instances (fan-out, isolation, heartbeat, drain)', () => {
  test('cross-instance fan-out: tenant A event reaches tenant A connections on BOTH instances; tenant B receives NOTHING', async () => {
    const bus = createMemoryBus();
    const instanceA = await startGateway({ bus });
    const instanceB = await startGateway({ bus });

    // Client A1 → instance #1; clients A2 + B1 → instance #2 (§78 shape).
    const resA1 = createMockRes();
    const resA2 = createMockRes();
    const resB1 = createMockRes();

    instanceA.admitStream({ companyId: COMPANY_A, userId: USER_A1, res: resA1 });
    instanceB.admitStream({ companyId: COMPANY_A, userId: USER_A2, res: resA2 });
    instanceB.admitStream({ companyId: COMPANY_B, userId: USER_B1, res: resB1 });

    const readyA1 = resA1.writes.join('');
    assert.ok(readyA1.includes('event: connection:ready'), 'admitted stream starts with the ready event');

    // Tenant-wide infrastructure proof event originates on instance #1.
    const result = await instanceA.publish({ type: 'realtime:proof', companyId: COMPANY_A, payload: { note: 'fanout-proof' } });
    await sleep0();

    assert.equal(result.delivered, 'pubsub');
    assert.ok(resA1.writes.join('').includes('fanout-proof'), 'A1 (instance #1) received');
    assert.ok(resA2.writes.join('').includes('fanout-proof'), 'A2 (instance #2) received — cross-instance fan-out works');
    assert.equal(resB1.writes.join('').includes('fanout-proof'), false, 'tenant B NEVER sees tenant A events');

    // Targeted user delivery: only USER_A1's connections, both instances.
    resA1.writes.length = 0;
    resA2.writes.length = 0;
    await instanceB.publish({ type: 'realtime:proof', companyId: COMPANY_A, userId: USER_A1, payload: { target: 'a1' } });
    await sleep0();

    assert.ok(resA1.writes.join('').includes('target'), 'targeted user receives on instance #1');
    assert.equal(resA2.writes.join('').includes('target'), false, 'other user of same tenant does not');

    await instanceA.stop();
    await instanceB.stop();
  });

  test('malformed pub/sub frames are ignored safely (no crash, no delivery)', async () => {
    const bus = createMemoryBus();
    const instance = await startGateway({ bus });
    const res = createMockRes();
    instance.admitStream({ companyId: COMPANY_A, userId: USER_A1, res });
    await sleep0();

    // Injection harness must be REAL (non-vacuous): reach the gateway's own
    // registered subscriber handler on the bus and drive it directly.
    const handlers = bus.registeredHandlers();
    assert.equal(handlers.length, 1, 'exactly one gateway subscriber is on the bus');
    const deliver = (raw) => handlers[0](realtimeChannelName('crewly:test'), raw);

    // POSITIVE control first: a valid envelope through the same path IS delivered.
    const valid = JSON.stringify(buildRealtimeEnvelope({ type: 'realtime:proof', companyId: COMPANY_A, payload: { ok: 1 } }));
    deliver(valid);
    await sleep0();
    assert.ok(res.writes.join('').includes('realtime:proof'), 'positive control proves the injection path works');

    // Raw garbage through the identical path: must be ignored, never crash, never deliver.
    const raw = JSON.stringify({ type: 'HACKED', companyId: COMPANY_A, payload: { evil: true } });
    deliver(raw);
    deliver('not-json-at-all');
    deliver(JSON.stringify({ type: 'system:ping', companyId: COMPANY_A, payload: { n: 1 } }).slice(0, 12));
    await sleep0();

    assert.equal(res.writes.join('').includes('HACKED'), false);
    assert.equal(res.writes.join('').includes('evil'), false);
    await instance.stop();
  });

  test('Redis unavailable → publish degrades to LOCAL-only delivery (documented §22)', async () => {
    // Stub connections that reject like a dead Redis — NEVER real ioredis
    // (start() must not spawn live connections against an unset REDIS_URL).
    const rejectingConn = () => ({
      on() {},
      subscribe: async () => {
        const error = new Error('ECONNREFUSED (stub)');
        error.code = 'ECONNREFUSED';
        throw error;
      },
      publish: async () => {
        const error = new Error('ECONNREFUSED (stub)');
        error.code = 'ECONNREFUSED';
        throw error;
      },
      quit: async () => {},
      disconnect() {},
    });
    const instance = createRealtimeGateway({
      enabled: true,
      channel: realtimeChannelName('crewly:test'),
      publisher: rejectingConn(),
      subscriber: rejectingConn(),
    });
    await instance.start();

    const res = createMockRes();
    instance.admitStream({ companyId: COMPANY_A, userId: USER_A1, res });

    const result = await instance.publish({ type: 'realtime:proof', companyId: COMPANY_A, payload: { local: true } });
    assert.equal(result.delivered, 'local');
    assert.ok(res.writes.join('').includes('local'));

    // New streams fail closed without a shared ticket store (HTTP level);
    // the gateway itself stays up and drains boundedly.
    await instance.stop();
    assert.equal(instance.isStarted(), false);
  });

  test('heartbeat keeps streams alive via comment frames and is NEVER employee presence', async () => {
    const bus = createMemoryBus();
    const instance = await startGateway({ bus, extra: { heartbeatMs: 10 } });
    const res = createMockRes();
    instance.admitStream({ companyId: COMPANY_A, userId: USER_A1, res });

    await sleep(40);
    assert.ok(res.writes.includes(':hb\n\n'), 'transport liveness frame delivered');
    assert.ok(!res.writes.join('').includes('lastActive'), 'heartbeat carries NO presence semantics');

    await instance.stop();
  });

  test('drain: stops acceptance, ends every local stream boundedly, closes owned connections, idempotent', async () => {
    const bus = createMemoryBus();
    const instance = await startGateway({ bus });
    const resA = createMockRes();
    const resB = createMockRes();
    instance.admitStream({ companyId: COMPANY_A, userId: USER_A1, res: resA });
    instance.admitStream({ companyId: COMPANY_B, userId: USER_B1, res: resB });

    const drained = await instance.stop();
    assert.equal(drained.closed, 2);
    assert.equal(resA.ended, true, 'client sees a safe close and reconnects elsewhere');
    assert.equal(resB.ended, true);
    assert.equal(bus.subscriberCount(), 0, 'owned pub/sub connections closed');
    assert.equal(instance.describeConnections().length, 0);

    await instance.stop(); // idempotent
    assert.equal((await instance.stop()).closed, 0);
  });

  test('disabled gateway is a no-op at start and stop (default-off law)', async () => {
    const instance = createRealtimeGateway({ enabled: false });
    const started = await instance.start();
    assert.deepEqual(started, { started: false, reason: 'DISABLED' });
    assert.equal(instance.isStarted(), false);
    await instance.stop();
  });

  test('stream cap refusal ends the response with a bounded 503 (no unlimited sockets)', () => {
    const instance = createRealtimeGateway({
      enabled: true,
      registry: createRealtimeRegistry({ maxStreams: 1, maxPerUser: 5 }),
    });

    instance.admitStream({ companyId: COMPANY_A, userId: USER_A1, res: createMockRes() });
    const rejected = createMockRes();
    const admission = instance.admitStream({ companyId: COMPANY_A, userId: USER_A2, res: rejected });

    assert.equal(admission.ok, false);
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.ended, true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('structural pins (§65 law guarantees, io-less)', () => {
  test('heartbeat is NOT employee presence — no User model, no availability writes anywhere in realtime infra', () => {
    const dir = path.join(here, '..', 'src', 'infrastructure', 'realtime');
    const files = fs.readdirSync(dir).map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
    const all = files.join('\n');

    assert.doesNotMatch(all, /models\/User/, 'realtime infrastructure must never load the User model');
    assert.doesNotMatch(all, /\blastActive\b|\blastSeen\b|\bavailability\b|\bisOnline\b|\bavailable\b/, 'no presence/product state (§30/§64)');
    assert.doesNotMatch(all, /message:new|typing:|presence:update/, 'no product event vocabulary (§17)');
  });

  test('route surface is exactly ticket + stream; ticket requires protect + tenant; stream is generic on failure', () => {
    const routes = read('routes/realtimeRoutes.js');
    assert.match(routes, /router\.post\(\s*'\s*\/ticket\s*',\s*protect,\s*tenantContext/);
    assert.match(routes, /'Realtime ticket is not valid'/, 'generic refusal — no enumeration oracle');
    assert.doesNotMatch(routes, /router\.(post|get)\(\s*'\s*\/(broadcast|publish|connections)/, '§36: no debug broadcast surface');
    assert.match(routes, /X-Accel-Buffering/, 'future proxy law carried on the stream response');
  });

  test('realtime connects only via explicit lifecycle (no import-time side effects)', () => {
    const gatewaySource = read('infrastructure/realtime/realtimeGateway.js');
    assert.doesNotMatch(gatewaySource, /new Redis\([^)]*\)(?![\s\S]*createRealtimeGateway)/, 'connections only inside the factory call path');
    assert.match(read('server.js'), /getRealtimeGateway\(\)\.start\(\)/, 'server owns the explicit start');
    assert.match(read('server.js'), /beginDrain\(`realtime-drain/, 'drain flips readiness first (32.2 order preserved)');
  });
});
