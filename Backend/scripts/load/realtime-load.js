#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.13 — REALTIME INFRASTRUCTURE LOAD (D-class, §26/§27)
//
//   $env:LOAD_TEST_TOKEN="<token from a normal login>"
//   $env:REALTIME_ENABLED="true"   (backend terminal)
//   npm run load:realtime -- --connections 50 --hold-ms 30000
//
// Measures the 32.11 FOUNDATION only: connection establishment latency
// through the ticket flow, idle-connection hold with heartbeats, and
// reconnect-burst behavior. NEUTRAL infrastructure events only — no
// Chat, no Presence, no product payload exists to send (§26).
//
// SAFETY: gradual ramp (step size), RSS memory guard on the generator,
// bounded hold time, ALL connections closed on exit AND on Ctrl+C
// (§27/§54) — no reconnect loops survive the run. Loopback-only target
// guard shared with api-load.js. Auth = one legitimate pre-supplied
// token (§70); the ticket itself is server-issued per connection.
// ═══════════════════════════════════════════════════════════════════════════
import '../../src/config/loadEnv.js';
import { performance } from 'node:perf_hooks';
import { clampInt } from './metrics.js';
import { validateTarget } from './targetGuard.js';

const MAX_CONNECTIONS = 200;
const RSS_GUARD_BYTES = 700 * 1024 * 1024; // generator memory budget (§47)

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const targetArg = flag('--target', 'http://localhost:5000');
const guardCheck = validateTarget({
  target: targetArg,
  explicit: args.includes('--target'),
  confirmedStagingHost: flag('--confirm-remote-is-safe-staging', ''),
});
if (!guardCheck.ok) {
  console.error(`✗ REFUSED: ${guardCheck.reason}`);
  process.exit(2);
}
const base = guardCheck.url.origin;

const connections = clampInt(flag('--connections', 20), 20, 1, MAX_CONNECTIONS);
const rampStep = clampInt(flag('--ramp-step', 10), 10, 1, MAX_CONNECTIONS);
const holdMs = clampInt(flag('--hold-ms', 30000), 30000, 1000, 180000);
const stepDelayMs = clampInt(flag('--step-delay-ms', 500), 500, 100, 10000);
const timeoutMs = clampInt(flag('--timeout', 8000), 8000, 2000, 30000);

const token = process.env.LOAD_TEST_TOKEN || '';
if (!token) {
  console.error('✗ This harness needs ONE legitimate login token:  $env:LOAD_TEST_TOKEN="<token>"  (never commit/print it)');
  process.exit(2);
}

console.log('════════════════════════════════════════════════');
console.log(`  CREWLY REALTIME INFRASTRUCTURE LOAD (neutral, read-only)`);
console.log(`  target: ${base} | connections: ${connections} (ramp step ${rampStep}) | hold: ${holdMs}ms`);
console.log('  MUTATION: NONE — infrastructure events only, no Chat/Presence exists');
console.log('════════════════════════════════════════════════');

let stopped = false;
const onSignal = () => {
  stopped = true;
  console.error('\n⚠ Interrupted — closing all connections…');
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

const openSse = async () => {
  const started = performance.now();
  // 1. Ticket via normal authenticated HTTP (the 32.11 contract).
  const ticketResponse = await fetch(`${base}/api/realtime/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!ticketResponse.ok) {
    return { ok: false, phase: `ticket ${ticketResponse.status}`, latencyMs: Math.round(performance.now() - started) };
  }
  const ticketBody = await ticketResponse.json().catch(() => null);
  const ticket = ticketBody?.data?.ticket;
  if (!ticket) return { ok: false, phase: 'ticket body malformed', latencyMs: Math.round(performance.now() - started) };

  // 2. SSE stream (no Origin header ⇒ server origin-allowlist passes).
  const streamResponse = await fetch(`${base}/api/realtime/stream?ticket=${encodeURIComponent(ticket)}`, {
    headers: { Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!streamResponse.ok || !streamResponse.body) {
    return { ok: false, phase: `stream ${streamResponse.status}`, latencyMs: Math.round(performance.now() - started) };
  }
  const latencyMs = Math.round(performance.now() - started);

  // 3. Hold: read frames in the background; count ready + heartbeats.
  const state = { ready: false, heartbeats: 0, closed: false };
  state.readerDone = streamResponse.body
    .pipeThrough(new TextDecoderStream())
    .pipeTo(
      new WritableStream({
        write(chunk) {
          if (chunk.includes('connection:ready')) state.ready = true;
          if (chunk.includes(':hb')) state.heartbeats += 1;
        },
      }),
    )
    .then(() => {
      state.closed = true;
    })
    .catch(() => {
      state.closed = true;
    });
  state.close = () => {
    try {
      streamResponse.body.cancel();
    } catch {
      /* already closed */
    }
  };
  return { ok: true, latencyMs, state };
};

const main = async () => {
  const sockets = [];
  const establishLatencies = [];
  let failures = 0;

  for (let opened = 0; opened < connections; opened += 1) {
    if (stopped) break;
    if (process.memoryUsage().rss > RSS_GUARD_BYTES) {
      console.error(`✗ STOP: generator RSS over ${Math.round(RSS_GUARD_BYTES / 1048576)}MB guard — not opening more connections (§27).`);
      break;
    }
    const result = await openSse();
    if (result.ok) {
      sockets.push(result.state);
      establishLatencies.push(result.latencyMs);
    } else {
      failures += 1;
      if (failures <= 3) console.error(`  ✗ connection ${opened + 1} failed at ${result.phase} (${result.latencyMs}ms)`);
    }
    if ((opened + 1) % rampStep === 0) {
      const readyCount = sockets.filter((state) => state.ready).length;
      console.log(`  … ${opened + 1}/${connections} attempted, ${readyCount} ready, RSS ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }
  }

  const readyCount = sockets.filter((state) => state.ready).length;
  const sorted = [...establishLatencies].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1] : null);
  console.log('──────────────────────────────────────────────');
  console.log(`  Opened: ${sockets.length}/${connections} (failed ${failures}) | ready: ${readyCount}`);
  console.log(`  Establish: p50=${pct(50)}ms p95=${pct(95)}ms max=${sorted[sorted.length - 1] ?? null}ms`);
  console.log(`  Holding ${holdMs}ms (heartbeats prove transport liveness — NOT presence)…`);

  const holdStarted = Date.now();
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  const heartbeatTotal = sockets.reduce((total, state) => total + state.heartbeats, 0);
  console.log(`  Heartbeats seen while holding: ${heartbeatTotal} across ${sockets.length} connections (${Math.round((Date.now() - holdStarted) / 1000)}s)`);

  console.log('  Closing ALL connections…');
  for (const state of sockets) state.close();
  await Promise.allSettled(sockets.map((state) => state.readerDone));
  console.log('  All connections closed — no reconnect loops remain (§27).');
  console.log('  Environment-only measurement — NOT a production capacity guarantee (§87).');
  console.log('──────────────────────────────────────────────');
  process.exit(failures > sockets.length ? 1 : 0);
};

main().catch((error) => {
  console.error(`✗ Realtime load failed: ${String(error?.message || 'unknown error').slice(0, 200)}`);
  process.exit(1);
});
