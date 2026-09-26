#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.15 — CONFIG PRE-FLIGHT CHECK (developer/deployment CLI)
//
//   npm run config:check [-- --production]
//
// Validates CURRENT process environment (Backend/.env is loaded via the
// standard loadEnv convention) against the SAME strict parsers the
// server uses — BEFORE anything serves traffic or opens network
// connections. This script performs NO I/O beyond reading env + files:
// no Mongo connect, no Redis ping, no SMTP, no storage.
//
// SECRET LAW (§22): output ever says only  NAME: configured | missing |
// invalid(<reason>) — NEVER a value, length, or fingerprint.
//
// Exit codes: 0 = valid; 1 = required/invalid problems (deployment must
// not proceed); 2 = usage error.
// ═══════════════════════════════════════════════════════════════════════════
import '../src/config/loadEnv.js'; // FIRST — same convention as other scripts

const args = process.argv.slice(2);
const productionFlag = args.includes('--production');
const nodeEnv = productionFlag
  ? 'production'
  : String(process.env.NODE_ENV || 'development').toLowerCase();

const state = (name, value, { secret = false } = {}) => ({
  name,
  status: String(value ?? '').trim() ? 'configured' : 'missing',
  secret,
});
const invalid = (name, reason) => ({ name, status: `invalid (${reason})` });

const report = [];
const problems = [];

const isProductionTarget = nodeEnv === 'production';

// ── APP ─────────────────────────────────────────────────────────────────────
report.push({ name: 'NODE_ENV', status: nodeEnv });
report.push({ name: 'PORT', status: String(process.env.PORT || '5000 (default)') });
report.push(state('CLIENT_URL', process.env.CLIENT_URL));

// ── DATABASE (required, all environments) ───────────────────────────────────
const mongo = state('MONGO_URI', process.env.MONGO_URI, { secret: true });
report.push(mongo);
if (mongo.status === 'missing') problems.push('MONGO_URI: required (authoritative business state)');

// ── AUTH ────────────────────────────────────────────────────────────────────
const jwt = state('JWT_SECRET', process.env.JWT_SECRET, { secret: true });
report.push(jwt);
report.push({ name: 'JWT_EXPIRES_IN', status: String(process.env.JWT_EXPIRES_IN || '7d (default)') });
const encryption = state('FIELD_ENCRYPTION_KEY', process.env.FIELD_ENCRYPTION_KEY, { secret: true });
report.push(encryption);
if (encryption.status === 'missing') {
  // §11: FEATURE UNAVAILABLE, not fatal — only flows using encrypted
  // fields need it; the operator verifies per deployment.
  report.push({ name: 'FIELD_ENCRYPTION_KEY', status: 'missing — WARNING: encrypted-field features unavailable (verify per deployment)' });
}

// Production-only law: reuse the EXACT server-side validator (§10).
if (isProductionTarget) {
  const { validateProductionConfig } = await import('../src/config/env.js');
  const verdict = validateProductionConfig(process.env);
  if (!verdict.ok) problems.push(...verdict.errors);
}

// ── REDIS (optional subsystem — strict parse, bounded) ──────────────────────
const { getRedisConfig } = await import('../src/config/redis.js');
const redisConfig = getRedisConfig(process.env);
report.push({ name: 'REDIS_ENABLED', status: String(redisConfig.enabled) });
report.push(state('REDIS_URL', process.env.REDIS_URL, { secret: true }));
report.push({ name: 'REDIS_CONNECT_TIMEOUT_MS', status: `valid (bounded) — configured: ${String(process.env.REDIS_CONNECT_TIMEOUT_MS || 'default')}` });
if (redisConfig.enabled && !redisConfig.hasUrl) {
  problems.push('REDIS_URL: REDIS_ENABLED=true requires a URL');
}

// ── QUEUES / WORKERS ────────────────────────────────────────────────────────
const queueConfig = await import('../src/config/queueConfig.js');
const bullmqPrefix = String(process.env.BULLMQ_PREFIX || queueConfig.getQueuePrefix());
report.push({ name: 'BULLMQ_PREFIX', status: `${bullmqPrefix.split(':')[0]}:<env> namespace (${bullmqPrefix === String(process.env.BULLMQ_PREFIX) ? 'override' : 'default'})` });
for (const [name, parse] of [
  ['WORKER_CONCURRENCY', queueConfig.parseWorkerConcurrency],
  ['PAYROLL_WORKER_CONCURRENCY', queueConfig.parsePayrollWorkerConcurrency],
]) {
  const value = process.env[name];
  const parsed = parse(process.env);
  report.push({ name, status: value === undefined ? `default (${parsed})` : `valid (${parsed})` });
}

// ── PROXY TRUST (32.3 — misconfiguration must fail startup) ─────────────────
const { parseProxyTrustConfig } = await import('../src/config/proxyTrust.js');
let proxyDescribe = 'direct (default)';
let proxyProblem = null;
try {
  const parsed = parseProxyTrustConfig(process.env);
  proxyDescribe = parsed.describe;
} catch (error) {
  proxyProblem = String(error?.message || 'invalid proxy trust configuration').replace(/"[^"]*"/g, '"<redacted>"');
}
report.push({
  name: 'TRUST_PROXY_MODE',
  status: String(process.env.TRUST_PROXY_MODE || 'direct (default)') + ` — ${proxyDescribe}`,
});
if (proxyProblem) problems.push(proxyProblem);

// ── REALTIME (32.11) / OBSERVABILITY (32.12) ────────────────────────────────
const { parseRealtimeEnabled } = await import('../src/infrastructure/realtime/realtimeConfig.js');
report.push({ name: 'REALTIME_ENABLED', status: String(parseRealtimeEnabled(process.env)) });
const { parseSlowRequestThresholdMs } = await import('../src/infrastructure/observability/observabilityConfig.js');
report.push({ name: 'OBSERVABILITY_SLOW_REQUEST_MS', status: `valid (${parseSlowRequestThresholdMs(process.env)}ms effective)` });

// ── CHAT HARDENING (33.11 — enablement, payload caps, limiter tier) ─────────
const { parseChatSocketEnabled, CHAT_MAX_HTTP_BUFFER_BYTES } = await import('../src/socket/socketConfig.js');
const { describeFrameCaps } = await import('../src/utils/chatPayloadCaps.js');

const chatEnabled = parseChatSocketEnabled(process.env);
report.push({ name: 'CHAT_SOCKET_ENABLED', status: String(chatEnabled) });

// Chat realtime is the ONE subsystem that cannot degrade: without Redis the
// adapter cannot fan out across instances, so every socket connection is
// refused FEATURE_UNAVAILABLE (33.1).
//
// DELIBERATELY A WARNING, NOT A BLOCKED DEPLOYMENT. The product already
// handles this shape truthfully — the API starts, REST keeps working, sockets
// are refused with a stable code, and the diagnostics block reports which
// reason. Pre-flight must not contradict the product's own behaviour by
// refusing to start it; it must make the trade-off impossible to miss.
const chatWithoutRedis = chatEnabled && !redisConfig.enabled;
report.push({
  name: 'CHAT_REALTIME_DEPENDENCY',
  status: chatWithoutRedis
    ? 'WARNING: chat enabled with Redis off — every socket connection will be refused (set CHAT_SOCKET_ENABLED=false for an honest disabled state, or enable Redis)'
    : 'ok',
});

// The transport must be able to carry what the product allows; this is the
// same law the test suite pins (utils/chatPayloadCaps.js).
const frameCaps = describeFrameCaps(CHAT_MAX_HTTP_BUFFER_BYTES);
report.push({
  name: 'CHAT_SOCKET_FRAME_CAP',
  status: `${frameCaps.capBytes} bytes (worst-case frame ${frameCaps.worstCaseFrameBytes}, ${frameCaps.sufficient ? 'sufficient' : 'INSUFFICIENT'})`,
});
if (!frameCaps.sufficient) {
  problems.push('chat socket frame cap is smaller than the product worst-case legal frame');
}

// Abuse controls follow the same tier as every other limiter (32.4): shared
// in Redis, or the bounded per-process bucket — never unlimited.
report.push({
  name: 'CHAT_RATE_LIMIT_TIER',
  status: redisConfig.enabled
    ? 'shared (Redis) — one budget across instances'
    : 'local per-process (degraded but ENFORCED — never unlimited)',
});

// ── EMAIL / STORAGE (feature-off capable; never validated as mandatory) ─────
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_FROM']) {
  report.push(state(name, process.env[name]));
}
report.push(state('SMTP_PASS', process.env.SMTP_PASS, { secret: true }));
for (const name of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY']) {
  report.push(state(name, process.env[name]));
}
report.push(state('CLOUDINARY_API_SECRET', process.env.CLOUDINARY_API_SECRET, { secret: true }));
for (const name of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']) {
  report.push(state(name, process.env[name], { secret: name.includes('SECRET') }));
}

// ── Output (names/statuses only) ────────────────────────────────────────────
console.log('════ CONFIG PRE-FLIGHT ════');
console.log(`  target environment: ${nodeEnv}${productionFlag ? ' (--production validation)' : ''}`);
for (const entry of report) {
  console.log(`  ${entry.name.padEnd(32)} ${entry.status}`);
}
console.log('────────────────────────────');
if (problems.length > 0) {
  console.error('✗ CONFIG PROBLEMS:');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('Deployment must NOT proceed until these are resolved.');
  process.exit(1);
}
console.log('✓ Configuration valid — safe to proceed (no network connections were made).');
process.exit(0);
