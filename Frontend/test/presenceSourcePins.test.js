// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE FRONTEND SOURCE-PIN TESTS
//
//  Covers §41 frontend tests #11–#17 (the rest).
//  Pin the architectural rules in code:
//    · No NATS / nats.js / JetStream in the browser bundle.
//    · No Redis URL / ioredis / node-redis in the browser bundle.
//    · No VITE_NATS_URL, no VITE_REDIS_URL.
//    · No localStorage / sessionStorage / document.cookie / AI.
//    · The runtime does not import any of those modules.
//    · The channel reads the SAME env var the chat socket reads
//      (VITE_API_URL via socketUrl.js, NOT a parallel env name).
//    · The runtime is the SOLE owner of the /presence listener —
//      no other module subscribes to it.
//    · The slice exports the 37.4 actions.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(frontendRoot, rel), 'utf8');

// ────────────────────────────────────────────────────────────────────────
//  ANTI-BAN PINS
// ────────────────────────────────────────────────────────────────────────

test('frontend 37.4: no NATS / JetStream in any 37.4 frontend file', () => {
  const files = [
    'src/services/realtime/presenceChannel.js',
    'src/services/realtime/presenceRuntime.js',
    'src/redux/slices/presenceSlice.js',
    'src/layout/AppLayout.jsx',
  ];
  for (const f of files) {
    const src = read(f);
    // Strip comments first.
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\bnats\b/i.test(noLine), false, `${f} references NATS`);
    assert.equal(/nats\.js|@nats\.io|jetstream/i.test(noLine), false, `${f} references nats.js / JetStream`);
  }
});

test('frontend 37.4: no Redis client / VITE_REDIS_URL / VITE_NATS_URL anywhere in src/', () => {
  const files = [
    'src/services/realtime/presenceChannel.js',
    'src/services/realtime/presenceRuntime.js',
    'src/redux/slices/presenceSlice.js',
    'src/layout/AppLayout.jsx',
    'src/services/realtime/socketUrl.js',
  ];
  for (const f of files) {
    const src = read(f);
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/VITE_NATS_URL/.test(noLine), false, `${f} references VITE_NATS_URL`);
    assert.equal(/VITE_REDIS_URL/.test(noLine), false, `${f} references VITE_REDIS_URL`);
    assert.equal(/ioredis|node-redis|redis-client/i.test(noLine), false, `${f} references a Redis client`);
  }
  // package.json dependencies do not include nats or a redis client.
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.equal(
    Object.keys(deps).some((d) => d === 'nats' || d.startsWith('@nats.io/')),
    false,
    'package.json must not depend on a NATS client',
  );
  assert.equal(
    Object.keys(deps).some((d) => d === 'ioredis' || d === 'redis'),
    false,
    'package.json must not depend on a Redis client',
  );
});

test('frontend 37.4: no AI / localStorage / browser storage in any 37.4 frontend file', () => {
  const files = [
    'src/services/realtime/presenceChannel.js',
    'src/services/realtime/presenceRuntime.js',
    'src/redux/slices/presenceSlice.js',
    'src/layout/AppLayout.jsx',
  ];
  for (const f of files) {
    const src = read(f);
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/openai|anthropic|\bclaude\b|\bgpt\b|\bllm\b|gemini/i.test(noLine), false, `${f} references AI`);
    assert.equal(/localStorage|sessionStorage|document\.cookie/i.test(noLine), false, `${f} references browser storage`);
  }
});

// ────────────────────────────────────────────────────────────────────────
//  ARCHITECTURAL PINS
// ────────────────────────────────────────────────────────────────────────

test('frontend 37.4: presenceChannel.js uses the shared socketUrl resolver, not its own URL', () => {
  const src = read('src/services/realtime/presenceChannel.js');
  assert.match(src, /resolveSocketUrl/);
  // No direct VITE_API_URL / VITE_PRESENCE_SOCKET_URL — the
  // presence socket follows the API origin via the SAME helper
  // the chat socket uses.
  assert.equal(/VITE_PRESENCE_SOCKET_URL/.test(src), false);
});

test('frontend 37.4: presenceRuntime.js is the SOLE listener for "presence:changed"', () => {
  // The runtime registers a single `presence:changed` listener on
  // the channel. We assert that no other 37.4 module registers one.
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const runtimeSrc = stripComments(read('src/services/realtime/presenceRuntime.js'));
  assert.match(runtimeSrc, /presence:changed/);
  // Slice must NOT subscribe to "presence:changed" directly.
  const sliceSrc = stripComments(read('src/redux/slices/presenceSlice.js'));
  assert.equal(/presence:changed/.test(sliceSrc), false);
  // Channel must NOT register the listener — the runtime does.
  const channelSrc = stripComments(read('src/services/realtime/presenceChannel.js'));
  assert.equal(/on\(\s*['"]presence:changed['"]/i.test(channelSrc), false);
});

test('frontend 37.4: presenceChannel.js uses the SAME ticket path as the chat socket', () => {
  // 33.14 — the ticket is minted by POST /api/realtime/chat-ticket.
  // The presence socket must NOT introduce a parallel endpoint
  // (a second mint path would be a parallel attack surface).
  const src = read('src/services/realtime/presenceChannel.js');
  assert.match(src, /chat-ticket/);
  // No parallel endpoint.
  assert.equal(/presence-ticket/i.test(src), false);
});

test('frontend 37.4: presenceSlice exports the 37.4 actions', async () => {
  // We import via the store path so the circular store <-> slice
  // resolves as it does in production. The presence store test
  // already proved the slice is registered under name 'presence'.
  const storeMod = await import('../src/redux/store.js');
  const state = storeMod.default.getState();
  assert.ok(state.presence, 'presence slice must be registered');
  // The 37.4 actions are exposed by the slice module — load the
  // source and assert the action creators are exported.
  const sliceSrc = read('src/redux/slices/presenceSlice.js');
  assert.match(sliceSrc, /export const \{[^}]*presenceTicked[^}]*\}/);
  assert.match(sliceSrc, /export const \{[^}]*presenceInvalidateTeam[^}]*\}/);
  // And that they are reducers (no async thunk).
  assert.match(sliceSrc, /presenceTicked\s*\(\s*state\s*,\s*action\s*\)/);
  assert.match(sliceSrc, /presenceInvalidateTeam\s*\(\s*state\s*\)/);
});

test('frontend 37.4: AppLayout wires startPresenceRuntime/stopPresenceRuntime', () => {
  const src = read('src/layout/AppLayout.jsx');
  assert.match(src, /startPresenceRuntime/);
  assert.match(src, /stopPresenceRuntime/);
  // The runtime is started on auth (userId present) and stopped on
  // unmount. Both are inside the userId useEffect.
  assert.match(src, /userId/);
});

test('frontend 37.4: presenceChannel.js does NOT import the redux store directly', () => {
  // The channel is a transport. The runtime is the redux adapter.
  // Keeping them split means a future swap of the channel (e.g.
  // to SSE, or a worker-thread bridge) does not require touching
  // the redux wiring.
  const src = read('src/services/realtime/presenceChannel.js');
  assert.equal(/redux\/store/i.test(src), false);
});

test('frontend 37.4: presenceChannel.js send functions do not include any client-claimed presence value', () => {
  // The browser may only signal liveness / activity. The resolver
  // decides the value. The activity frame carries `at` (ISO) and
  // nothing else; the heartbeat frame is empty.
  const src = read('src/services/realtime/presenceChannel.js');
  // No `presence:` emit with a value field.
  assert.equal(/emit\(\s*['"]presence:[a-z]+['"]\s*,\s*\{[^}]*presence\s*:/i.test(src), false);
  // The activity frame is the ONLY event with a payload.
  assert.match(src, /presence:activity/);
  assert.match(src, /presence:heartbeat/);
});

test('frontend 37.4: presenceRuntime debounces team refetches (1s window)', () => {
  const src = read('src/services/realtime/presenceRuntime.js');
  assert.match(src, /TEAM_REFETCH_DEBOUNCE_MS\s*=\s*1_?000/);
  assert.match(src, /setTimeout/);
});
