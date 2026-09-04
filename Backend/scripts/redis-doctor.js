// ============================================================
// PHASE 30.1.2 — REDIS DOCTOR (developer command, read-only)
//
//   npm run redis:doctor
//
// One command that answers "is Redis actually usable for Crewly?"
// instead of only "can I PING it?". It walks the SAME code paths the
// running application uses:
//
//   1. config      - REDIS_ENABLED / REDIS_URL present (secret-safe)
//   2. url         - CLOUD PRE-FLIGHT: TLS scheme vs port, missing/ACL
//                    username, unescaped characters in the password,
//                    stray whitespace/quotes from copy-paste, non-zero DB
//   3. connect     - src/config/redis.js initializeRedis + health map
//   4. latency     - bounded PING sample (managed links are slower)
//   5. server      - version / mode (replica = read-only = fatal)
//   6. commands    - are the commands Crewly/BullMQ need permitted, and are
//                    the dangerous ones (KEYS/FLUSHDB) blocked for us
//   7. eviction    - maxmemory-policy (allkeys-* can delete queue jobs)
//   8. memory      - used vs max memory + evicted_keys (+ -OOM reporting)
//   9. probe       - SET/GET/TTL/DEL round trip on ONE exact self-built key
//  10. queues      - live BullMQ job counts per Crewly queue
//  11. workers     - Phase 28.8 heartbeat => ONLINE / OFFLINE
//  12. keyspace    - DBSIZE + INFO keyspace (informational)
//
// MANAGED REDIS (Redis Cloud / Upstash / ElastiCache / Azure Cache) is a
// first-class case: those tiers block some introspection commands, so the
// affected checks report SKIP with the console field to read instead, and a
// blocked command is only a FAIL when Crewly actually needs it.
//
// SAFETY RULES (same discipline as the production modules):
//   - REDIS_URL is never printed, logged or embedded in an error.
//   - Read-only apart from one ephemeral probe key that it deletes.
//   - NO FLUSHALL / FLUSHDB / KEYS / SCAN — exact keys and INFO only.
//   - Every check is time-bounded; a dead Redis cannot hang this script.
//
// Exit codes (predictable policy):
//   0 — no FAIL (warnings allowed and explained)
//   1 — a FAIL, or Redis disabled/misconfigured, or the watchdog fired
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports
import { randomBytes } from 'node:crypto';
import {
  initializeRedis,
  getRedisClient,
  getRedisHealth,
  getRedisStatus,
  pingRedis,
  closeRedis,
  getRedisConfig,
  classifySafeReason,
} from '../src/config/redis.js';
import { getQueuePrefix, QUEUE_NAMES } from '../src/config/queueConfig.js';
import { getQueue, closeAllQueues } from '../src/queues/queueFactory.js';
import { heartbeatKeyFor, workerMemberKey } from '../src/workers/workerHeartbeat.js';

// --- Output helpers ------------------------------------------------

const LABEL_WIDTH = 11;
const TAG = { OK: '[ OK ]', WARN: '[WARN]', FAIL: '[FAIL]', SKIP: '[SKIP]' };
const results = [];

const report = (name, status, detail, hint = null) => {
  results.push({ name, status, hint });
  const label = `${TAG[status]} ${String(name).padEnd(LABEL_WIDTH)}`;
  console.log(`${label}  ${detail}`);
  if (hint) console.log(`           -> ${hint}`);
};

// Section header, keeps the ladder scannable in a terminal.
const section = (title) => console.log(`\n${title}`);

// --- Bounded execution --------------------------------------------

const CHECK_TIMEOUT_MS = 5000;
// Whole-script watchdog: a hung network call can never make this
// command wait forever.
const WATCHDOG_MS = 120000;

const withTimeout = async (label, promise, timeoutMs = CHECK_TIMEOUT_MS) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { __error: error };
  } finally {
    clearTimeout(timer);
  }
};

const failed = (value) => value && typeof value === 'object' && '__error' in value;

// INFO blocks are "\r\n" separated "key:value" lines.
const parseInfo = (raw) => {
  const map = new Map();
  for (const line of String(raw ?? '').split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    map.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return map;
};

// Only non-sensitive shape statistics — never host, port or password.
const describeUrlShape = () => {
  const raw = String(process.env.REDIS_URL ?? '').trim();
  const scheme = raw.startsWith('rediss://') ? 'rediss:// (TLS)' : raw.startsWith('redis://') ? 'redis://' : 'unrecognised scheme';
  return `length=${raw.length} scheme=${scheme}`;
};

const WINDOWS_HINTS = [
  '  1. Docker Desktop : docker run -d --name crewly-redis -p 6379:6379 redis:7-alpine',
  '  2. WSL2 (Ubuntu) : sudo apt-get install -y redis-server && sudo service redis-server start',
  '  3. Memurai (native Windows service): https://www.memurai.com/get-memurai',
  'Then in Backend/.env set REDIS_ENABLED=true and REDIS_URL=redis://127.0.0.1:6379',
  'Verify the port is answering: Test-NetConnection localhost -Port 6379',
];

// --- Cloud provider knowledge -------------------------------------

// A managed endpoint is detected from the hostname SHAPE only (never
// printed) so provider quirks can be explained without exposing anything.
// Covers Redis Cloud, Upstash, ElastiCache and Azure Cache hostnames; the
// host itself is never printed, only its length.
const MANAGED_HOST =
  /(^|\.)(redis\.io|redislabs\.com|rlrcp\.com|upstash\.io|upstash\.com|cache\.amazonaws\.com|redis\.cache\.windows\.net|database\.windows\.net)$/i;
const isManagedHost = (hostname) =>
  MANAGED_HOST.test(String(hostname || '').toLowerCase()) ||
  /^redis-\d+\.c/i.test(String(hostname || ''));

// Where to read the same fact in each provider's console when the Redis
// command itself is blocked (very common on managed tiers).
const DASHBOARD = {
  INFO: 'Redis Cloud: database page diagnostics | Upstash: console > Statistics | ElastiCache: CloudWatch',
  CONFIG: 'Redis Cloud: database > Advanced > Eviction policy | Upstash: Settings > Max memory policy | ElastiCache: parameter group maxmemory-policy',
  COMMAND: 'Upstash: console > Settings > Redis commands | Redis Cloud: security > Disabled commands | Azure Cache: "Redis commands" policy',
};
const hintFor = (command) =>
  DASHBOARD[command] || 'this command is disabled by the provider policy';

// Printed whenever credentials look unescaped (the value never is).
const ENCODE_TABLE = 'encode as %40 (@) %3A (:) %2F (/) %23 (#) %5B ([) %5D (]) %25 (%)';

const checkUrl = () => {
  const raw = String(process.env.REDIS_URL ?? '');
  const problems = [];
  const notes = [];
  if (/^\s|\s$/.test(raw)) {
    problems.push('the value has leading/trailing whitespace - a stray space or a Windows line break in .env breaks the URL');
  }
  if (/\r|\n|\t/.test(raw)) {
    problems.push('the value contains a line break or tab (paste artifact)');
  }
  const trimmed = raw.trim();
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) {
    problems.push('the value is wrapped in quotes - .env must be REDIS_URL=rediss://... with no quotes');
  }

  let url = null;
  try {
    url = new URL(trimmed);
  } catch {
    problems.push('the value cannot be parsed as a redis:// or rediss:// URL');
  }

  if (url) {
    const hostname = url.hostname;
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      problems.push(`unsupported scheme "${url.protocol}" - use redis:// (no TLS) or rediss:// (TLS)`);
    }
    if (!hostname) problems.push('no host in the URL');

    // Credentials = everything between "://" and the LAST "@" (raw string,
    // so an unescaped "@" in the password is detectable at all).
    const authorityStart = trimmed.indexOf('://') + 3;
    const at = trimmed.lastIndexOf('@');
    const credentials = at > authorityStart ? trimmed.slice(authorityStart, at) : '';
    if (isManagedHost(hostname)) {
      if (!credentials) {
        notes.push('managed endpoint with no credentials - Redis Cloud and Upstash always require a password/token');
      } else if (!credentials.includes(':')) {
        notes.push('password without a username - Upstash and ACL Redis Cloud users need rediss://default:<token>@host:port (read-only tokens use default_ro)');
      }
      if (url.protocol === 'redis:') {
        notes.push('redis:// to a managed endpoint sends the credential unencrypted - most providers only expose TLS (rediss://)');
      }
    }
    if (credentials) {
      const split = credentials.indexOf(':');
      const secret = split === -1 ? credentials : credentials.slice(split + 1);
      const bad = /[@?:/#[\]]/.exec(secret);
      if (bad) {
        problems.push(`the password contains "${bad[0]}" which the URL parser treats as a separator - ${ENCODE_TABLE}`);
      }
      if (/%(?![0-9A-Fa-f]{2})/.test(secret)) {
        problems.push(`the password has a "%" that is not a valid escape - ${ENCODE_TABLE}`);
      }
    }
    const port = Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379));
    const localHost = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/.test(hostname);
    if (url.protocol === 'rediss:' && localHost) {
      notes.push('rediss:// (TLS) points at a local host - Docker/WSL/Memurai Redis normally has NO TLS; use redis://127.0.0.1:6379 for local and keep rediss:// for the managed endpoint');
    }
    if (url.protocol === 'redis:' && localHost && credentials) {
      notes.push('a password on a local endpoint is unusual - if Redis was started without requirepass, remove the credentials (ioredis AUTH would be rejected)');
    }
    if (url.protocol === 'rediss:' && port === 6379) {
      notes.push('TLS (rediss://) against port 6379 - Redis Cloud/Upstash serve TLS on their own port (commonly 6380); 6379 is usually plain text');
    }
    if (url.protocol === 'redis:' && port === 6380) {
      notes.push('plain redis:// against the usual TLS port 6380 - if the handshake fails, the endpoint expects rediss://');
    }
    const dbPath = String(url.pathname || '');
    if (dbPath && dbPath !== '/' && dbPath !== '/0') {
      notes.push(`the URL selects database ${dbPath.replace('/', '')} - queues and cache live there too, so keep BULLMQ_PREFIX unique per environment`);
    }
  }

  if (problems.length > 0) {
    report('url', 'FAIL', problems[0], problems.slice(1).join(' | '));
    return false;
  }
  const shape =
    `scheme=${url.protocol.replace(':', '')} host=<hidden, ${url.hostname.length} chars> ` +
    `port=${url.port || 'default'} credentials=${url.password ? `yes (${url.password.length} chars)` : 'none'}`;
  if (notes.length > 0) {
    report('url', 'WARN', shape, notes.join(' | '));
    return true;
  }
  report('url', 'OK', `${shape} (${isManagedHost(url.hostname) ? 'managed endpoint' : 'local/self-hosted shape'})`);
  return true;
};


const checkConfig = () => {
  const config = getRedisConfig();
  const guidance = (note, header = 'To run Redis locally (pick any):') => {
    console.log(`           -> ${note}`);
    console.log(`           ${header}`);
    WINDOWS_HINTS.forEach((line) => console.log(`           ${line}`));
  };
  if (!config.enabled) {
    report('config', 'FAIL', 'REDIS_ENABLED is not true — this check needs a live Redis', null);
    guidance('Set REDIS_ENABLED=true in Backend/.env (the API may stay Redis-free on purpose; queues and caching need it)', 'To run Redis locally (pick any):');
    return false;
  }
  if (!config.hasUrl) {
    report('config', 'FAIL', 'REDIS_ENABLED=true but REDIS_URL is empty (misconfigured)', null);
    guidance('Add REDIS_URL=redis://127.0.0.1:6379 (or your managed rediss:// URL) to Backend/.env');
    return false;
  }
  report('config', 'OK', `REDIS_ENABLED=true, REDIS_URL present (${describeUrlShape()})`);
  return true;
};

const checkConnect = async () => {
  const startedAt = Date.now();
  // The real production entry point — a green line here means the API
  // will come up with the same configuration.
  await withTimeout('initializeRedis', initializeRedis(), Math.min(60000, getRedisConfig().connectTimeoutMs + 2000));
  const health = getRedisHealth();
  if (health.status !== 'up') {
    const state = getRedisStatus();
    const reason = health.reason || state.reason || 'unavailable';
    const meaning = {
      connection_refused: 'nothing is listening on that host:port (Redis not started, or wrong port)',
      dns_resolution_failed: 'the host in REDIS_URL cannot be resolved (typo / VPN / offline)',
      auth_failed: 'the server rejected the credentials in REDIS_URL',
      timeout: 'the server did not answer in time (firewall / slow network)',
      connection_error: 'socket-level error before the connection was ready',
    }[reason] || `redis.js state=${state.state}`;
    report('connect', 'FAIL', `health "${health.status}" — ${reason}`, meaning);
    console.log('           Redis is not reachable from this machine. To run one locally:');
    WINDOWS_HINTS.slice(0, 3).forEach((line) => console.log(`           ${line}`));
    return false;
  }
  report('connect', 'OK', `connected and ready in ${Date.now() - startedAt} ms — health "up"`);
  return true;
};

const checkLatency = async (client) => {
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const startedAt = process.hrtime.bigint();
    const pong = await withTimeout('ping', client.ping());
    if (failed(pong) || pong !== 'PONG') {
      report('latency', 'FAIL', 'PING did not return PONG', 'The connection dropped between checks — re-run to confirm');
      return false;
    }
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const max = Math.max(...samples);
  const internalPing = await pingRedis(); // exercises the module helper too
  if (avg > 100) {
    report('latency', 'WARN', `PING avg ${avg.toFixed(1)} ms (max ${max.toFixed(1)} ms) - remote link`, 'Normal when you are not co-located with the region. Every Redis call is now a network call: keep REDIS_CACHE_OP_TIMEOUT_MS small (the cache is fail-open) and expect the worker, not Redis, to be the queue bottleneck');
    return true;
  }
  report('latency', 'OK', `PING avg ${avg.toFixed(1)} ms (max ${max.toFixed(1)} ms), pingRedis()=${internalPing}`);
  return true;
};

const checkServer = async (client) => {
  const info = await withTimeout('info.server', client.info('server'));
  if (failed(info)) {
    report('server', 'SKIP', 'INFO server is not permitted by this provider', `not a fault - read the version in the console instead. ${hintFor('INFO')}`);
    return true;
  }
  const fields = parseInfo(info);
  const version = fields.get('redis_version') || 'unknown';
  const mode = fields.get('redis_mode') || 'standalone';
  const [major, minor] = version.split('.').map((part) => Number(part) || 0);
  const parts = `version=${version} mode=${mode} os=${fields.get('os') || '?'}`;
  if (mode !== 'standalone') {
    report('server', 'WARN', parts, 'Crewly targets a standalone/primary endpoint — cluster mode needs client-side sharding and is not configured');
    return true;
  }
  if (major < 6 || (major === 6 && minor < 2)) {
    report('server', 'WARN', parts, 'BullMQ needs Redis >= 5.0; Crewly is validated on 6.2+/7.x — consider upgrading');
    return true;
  }
  report('server', 'OK', parts);
  return true;
};

const checkRole = async (client) => {
  const info = await withTimeout('info.replication', client.info('replication'));
  if (failed(info)) {
    report('role', 'SKIP', 'INFO replication is not permitted by this provider', `role unknown - a read-only replica/standby endpoint rejects every queue write. ${hintFor('INFO')}`);
    return true;
  }
  const role = parseInfo(info).get('role') || 'unknown';
  if (role === 'slave' || role === 'replica') {
    report('role', 'FAIL', `endpoint is a read-only ${role}`, 'Point REDIS_URL at the primary (writes such as BullMQ job pushes fail with -READONLY on a replica)');
    return false;
  }
  report('role', 'OK', `role=${role} (writable)`);
  return true;
};

const checkScripting = async (client) => {
  const result = await withTimeout('eval', client.eval('return 1', 0));
  if (failed(result) || Number(result) !== 1) {
    const code = result?.__error?.code || result?.__error?.message?.slice(0, 60) || 'blocked';
    report('scripting', 'FAIL', `EVAL is not usable (${code})`, 'BullMQ runs entirely on Lua scripts — a provider that disables scripting cannot host the queues');
    return false;
  }
  report('scripting', 'OK', 'EVAL (Lua) available — required by BullMQ');
  return true;
};

// Crewly and BullMQ need these. Managed tiers sometimes block a subset,
// and a blocked command that the queues need is fatal long before the first
// job is ever enqueued - so it is checked up front, in one round trip.
const REQUIRED_COMMANDS = Object.freeze([
  'eval', 'evalsha', 'script', 'multi', 'exec', 'lpush', 'rpop', 'zadd',
  'hgetall', 'pttl', 'publish', 'subscribe', 'xadd', 'xgroup',
]);
// Never a failure: the production code never calls these, and a provider
// that blocks them is simply a safer shared instance.
const HARDENING_COMMANDS = Object.freeze(['keys', 'flushdb', 'flushall', 'scan']);

const checkCommands = async (client) => {
  const info = await withTimeout(
    'command.info',
    client.command('INFO', [...REQUIRED_COMMANDS, ...HARDENING_COMMANDS])
  );
  if (failed(info) || !Array.isArray(info)) {
    // COMMAND itself is blocked (common on Upstash/Redis Cloud). Not a
    // fault: the EVAL probe already proved the critical capability.
    report('commands', 'SKIP', 'COMMAND INFO is not permitted on this endpoint', hintFor('COMMAND'));
    return true;
  }
  // COMMAND INFO answers in the order asked; an unavailable command is null.
  const unavailable = (entry) => entry === null || entry === undefined;
  const blocked = REQUIRED_COMMANDS.filter((name, index) => unavailable(info[index]));
  const hardened = HARDENING_COMMANDS.filter((name, index) =>
    unavailable(info[REQUIRED_COMMANDS.length + index])
  );
  const detail =
    `${REQUIRED_COMMANDS.length - blocked.length}/${REQUIRED_COMMANDS.length} queue-critical commands available` +
    (hardened.length > 0 ? `; destructive commands blocked by policy: ${hardened.join(', ')}` : '');
  if (blocked.length > 0) {
    report('commands', 'FAIL', `${detail} | missing: ${blocked.join(', ')}`, `BullMQ cannot run without these - enable them in the provider policy. ${hintFor('COMMAND')}`);
    return false;
  }
  report('commands', 'OK', detail);
  return true;
};


const checkEviction = async (client, maxMemoryBytes = 0) => {
  const config = await withTimeout('config.maxmemory', client.config('GET', 'maxmemory-policy'));
  if (failed(config) || !Array.isArray(config) || config.length === 0) {
    report('eviction', 'SKIP', 'CONFIG GET maxmemory-policy is not permitted here', `confirm the policy in the console - allkeys-* can evict queue keys. ${hintFor('CONFIG')}`);
    return true;
  }
  const policy = String(config[1] ?? 'unknown');
  const risky = policy.startsWith('allkeys-');
  if (risky) {
    report('eviction', 'FAIL', `maxmemory-policy=${policy}`, 'This policy can evict BullMQ queue/cache keys under memory pressure and silently lose jobs — set noeviction (or use a dedicated Redis)');
    return false;
  }
  if (policy.startsWith('volatile-')) {
    // BullMQ prints its own warning on every connection:
    //   IMPORTANT! Eviction policy is volatile-lru. It should be "noeviction"
    // so a queue host sees ~20 identical lines at worker start. Accurate
    // reasoning: BullMQ's list/stream/zset queue keys carry no TTL and are
    // therefore not eviction candidates - the danger is what happens when the
    // cap is reached and the only TTL keys left are BullMQ's rate-limiter and
    // events/metrics keys, or nothing at all (-OOM on every write).
    const capNote = maxMemoryBytes > 0
      ? `a maxmemory cap is set (${Math.round(maxMemoryBytes / 1048576)} MB): at the cap, TTL keys such as the BullMQ rate-limiter and events retention get evicted and then writes fail with -OOM`
      : 'no maxmemory cap reported, so eviction cannot trigger today - but the risk appears the moment a cap or a full instance is in play';
    report('eviction', 'WARN', `maxmemory-policy=${policy}`, `BullMQ warns about this on every connection. ${capNote}. Change it to noeviction in the provider configuration - no code change, no data migration, restart the worker so the warning clears. ${hintFor('CONFIG')}`);
    return true;
  }
  report('eviction', 'OK', `maxmemory-policy=${policy} — matches the BullMQ requirement (no startup warnings)`);
  return true;
};

const checkMemory = async (client) => {
  const info = await withTimeout('info.memory', client.info('memory'));
  const stats = await withTimeout('info.stats', client.info('stats'));
  if (failed(info)) {
    report('memory', 'SKIP', 'INFO memory is not permitted by this provider', hintFor('INFO'));
    return { maxMemoryBytes: 0, ok: true };
  }
  const fields = parseInfo(info);
  const used = fields.get('used_memory_human') || '?';
  const maxMemoryBytes = Number(fields.get('maxmemory') || 0);
  const max = maxMemoryBytes > 0 ? fields.get('maxmemory_human') || `${maxMemoryBytes}B` : 'unbounded';
  const ratio = Number(fields.get('used_memory') || 0) / Math.max(1, Number(fields.get('maxmemory') || 0));
  const evicted = failed(stats) ? 0 : Number(parseInfo(stats).get('evicted_keys') || 0);
  const detail = `used=${used} max=${max} evicted_keys=${evicted}`;
  if (evicted > 0) {
    report('memory', 'WARN', detail, `${evicted} keys were evicted — the instance has hit its memory limit; jobs can be lost, raise maxmemory or move to a bigger tier`);
    return true;
  }
  if (maxMemoryBytes > 0 && ratio > 0.9) {
    report('memory', 'WARN', detail, 'above 90% of maxmemory — Redis will start evicting/rejecting writes');
    return { maxMemoryBytes, ok: true };
  }
  report('memory', 'OK', detail);
  return { maxMemoryBytes, ok: true };
};

// Exact self-built key, TTL as a belt-and-braces, deleted at the end.
const checkProbe = async (client) => {
  const key = `crewly:ops:doctor:${randomBytes(6).toString('hex')}`;
  const payload = JSON.stringify({ probe: true, at: Date.now() });
  const set = await withTimeout('probe.set', client.set(key, payload, 'EX', 30));
  if (failed(set) || set !== 'OK') {
    const writeError = `${set?.__error?.code || ''} ${set?.__error?.message || ''}`;
    const reason = /OOM|not enough memory|maxmemory/i.test(writeError)
      ? 'the instance is out of memory (-OOM) - raise the plan; queues must never rely on eviction'
      : /READONLY|replica|read-only/i.test(writeError)
        ? 'read-only endpoint - an Upstash read-only token uses the default_ro user, and a replica endpoint rejects writes'
        : /unknown command|not allowed|disabled|NOPERM/i.test(writeError)
          ? `the provider policy blocks writes or SET - ${hintFor('COMMAND')}`
          : 'check the write permission of the ACL user in REDIS_URL';
    report('probe', 'FAIL', `SET was rejected (${writeError.trim().slice(0, 48) || 'no detail'})`, reason);
    return false;
  }
  const [got, ttl, exists] = await withTimeout(
    'probe.read',
    Promise.all([client.get(key), client.ttl(key), client.exists(key)])
  );
  const deleted = await withTimeout('probe.del', client.del(key));
  const after = await withTimeout('probe.after', client.exists(key));
  const ok = got === payload && Number(exists) === 1 && Number(ttl) > 0 && Number(deleted) === 1 && Number(after) === 0;
  if (!ok) {
    report('probe', 'FAIL', `round trip mismatch (get=${got === payload ? 'match' : 'DIFFERENT'} ttl=${ttl} deleted=${deleted})`, 'Do NOT trust queues/caching on this instance until the round trip is clean');
    return false;
  }
  report('probe', 'OK', `SET/GET/TTL/DEL clean on ${key} (ttl=${ttl}s, removed=true)`);
  return true;
};

const checkQueues = async (onlineWorkers) => {
  const names = Object.values(QUEUE_NAMES);
  const lines = [];
  let failedTotal = 0;
  let waitingTotal = 0;
  let delayedTotal = 0;
  const paused = [];
  try {
    for (const name of names) {
      const queue = getQueue(name); // dedicated producer connection per queue
      const counts = await withTimeout(`counts.${name}`, queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'));
      if (failed(counts)) {
        lines.push(`  ${name.padEnd(10)} counts unavailable (${counts?.__error?.code || 'timeout'})`);
        continue;
      }
      const waiting = counts.waiting || 0;
      const active = counts.active || 0;
      const delayed = counts.delayed || 0;
      const failureCount = counts.failed || 0;
      failedTotal += failureCount;
      delayedTotal += counts.delayed || 0;
      const isPaused = await withTimeout(`paused.${name}`, queue.isPaused());
      waitingTotal += waiting;
      if (!failed(isPaused) && isPaused === true) paused.push(name);
      lines.push(
        `  ${name.padEnd(10)} waiting=${waiting} active=${active} delayed=${delayed} failed=${failureCount}${isPaused === true ? ' PAUSED' : ''}`
      );
    }
  } catch (error) {
    // getQueue throws when Redis is not configured; already reported
    // by checkConfig/checkConnect, so keep this non-fatal.
    report('queues', 'SKIP', `queue inventory unavailable (${error?.message?.slice(0, 60) || 'error'})`);
    return true;
  }

  console.log(lines.join('\n'));
  const prefix = getQueuePrefix();
  const summary = `${names.length} queues under prefix "${prefix}"`;
  if (failedTotal > 0) {
    report('queues', 'WARN', `${summary}: ${failedTotal} failed job(s)`, 'Open Super Admin > Background Operations to inspect/retry (npm run test:ops:live proves the ladder)');
    return true;
  }
  if (paused.length > 0) {
    report('queues', 'WARN', `${summary}: paused queues — ${paused.join(', ')}`, 'Resume from the ops page before trusting job timing');
    return true;
  }
  // Waiting jobs only matter in relation to a live worker: with none
  // online the backlog can never drain.
  if (waitingTotal > 0 && onlineWorkers === 0) {
    report('queues', 'WARN', `${summary}: ${waitingTotal} job(s) waiting and no worker ONLINE`, 'Start the consumer: npm run worker:dev — a one-off job in a dev queue is harmless, a growing count is not');
    return true;
  }
  if (waitingTotal > 200) {
    report('queues', 'WARN', `${summary}: waiting=${waitingTotal} delayed=${delayedTotal}`, 'Workers are not keeping up — check npm run worker and WORKER_CONCURRENCY');
    return true;
  }
  report('queues', 'OK', `${summary}: waiting=${waitingTotal} delayed=${delayedTotal} — no failures, no stuck backlog`);
  return true;
};

const checkWorkers = async (client) => {
  const members = await withTimeout('heartbeat', client.smembers(workerMemberKey()));
  if (failed(members) || !Array.isArray(members) || members.length === 0) {
    report('workers', 'WARN', 'no worker heartbeat key found', 'Background jobs are not being processed. Start the worker: npm run worker:dev (heartbeat appears within ~15s)');
    return 0;
  }
  const now = Date.now();
  const states = [];
  let online = 0;
  for (const workerId of members.slice(0, 20)) {
    const key = heartbeatKeyFor(workerId);
    const [raw, remainingTtl] = await withTimeout(
      `hb.${workerId}`,
      Promise.all([client.get(key), client.ttl(key)])
    );
    if (failed(raw) || !raw) {
      // A member without a live key is a stale registration (the
      // process died before it could deregister) — the TTL expired.
      states.push(`${workerId}: offline (stale member)`);
      continue;
    }
    try {
      const beat = JSON.parse(raw);
      const ageSeconds = Math.round((now - Number(beat.ts || 0)) / 1000);
      // The key's own TTL is the authority: it is refreshed on every
      // beat and simply lapses when the process dies.
      const live = beat.state === 'online' && Number(remainingTtl) > 0;
      if (live) online += 1;
      states.push(`${workerId}: ${beat.state} (${ageSeconds}s ago, ttl=${remainingTtl}s)${live ? '' : ' -> OFFLINE'}`);
    } catch {
      states.push(`${workerId}: unreadable heartbeat value`);
    }
  }
  console.log(states.map((line) => `  ${line}`).join('\n'));
  if (online === 0) {
    report('workers', 'WARN', 'heartbeat set exists but no worker is currently ONLINE', 'The worker died or is shutting down — npm run worker:dev, then re-run');
    return 0;
  }
  report('workers', 'OK', `${online} worker process(es) ONLINE`);
  return online;
};

const checkKeyspace = async (client) => {
  const [dbsize, info] = await withTimeout(
    'keyspace',
    Promise.all([client.dbsize(), client.info('keyspace')])
  );
  if (failed(info)) {
    report('keyspace', 'SKIP', 'INFO keyspace is not permitted by this provider', hintFor('INFO'));
    return true;
  }
  const summary = String(info).split('\r\n').filter((line) => line.includes('keys=')).join(' | ') || 'no keys yet';
  report('keyspace', 'OK', `db0 keys=${Number(dbsize) || 0}; ${summary}`);
  return true;
};

// --- Runner ---------------------------------------------------------

const main = async () => {
  console.log('Crewly HRMS - Redis doctor (read-only)');
  section('1/6 Configuration');
  if (!checkConfig()) return finish();
  // Pre-flight before any socket is opened: a malformed cloud URL is the
  // most common reason a managed Redis "does not work".
  if (!checkUrl()) return finish();

  section('2/6 Connection');
  const up = await checkConnect();
  const client = getRedisClient();
  if (!up || !client) return finish();

  section('3/6 Server capabilities');
  await checkLatency(client);
  await checkServer(client);
  await checkScripting(client);
  await checkCommands(client);

  section('4/6 Operational limits');
  await checkRole(client);
  const memoryLimits = await checkMemory(client);
  await checkEviction(client, memoryLimits.maxMemoryBytes);
  await checkProbe(client);

  section('5/6 Crewly queues and workers');
  const onlineWorkers = await checkWorkers(client);
  await checkQueues(onlineWorkers);

  section('6/6 Keyspace');
  await checkKeyspace(client);

  return finish();
};

const finish = async () => {
  // Everything this script opened is closed here — never leaves
  // sockets or queue connections behind.
  try {
    await closeAllQueues();
  } catch {
    /* ignore */
  }
  try {
    await closeRedis();
  } catch {
    /* ignore */
  }

  const counts = results.reduce(
    (acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }),
    { OK: 0, WARN: 0, FAIL: 0, SKIP: 0 }
  );
  const verdict = counts.FAIL > 0 ? 'BLOCKED' : counts.WARN > 0 ? 'USABLE WITH WARNINGS' : 'READY';
  console.log(`\nSummary: ${counts.OK} ok, ${counts.WARN} warning(s), ${counts.SKIP} skipped, ${counts.FAIL} failed`);
  if (verdict === 'READY') {
    console.log('Verdict: Redis is ready for Crewly (caching, BullMQ queues, worker heartbeat).');
    console.log('Next: npm run test:redis:live  (cache abstraction)  |  npm run test:bullmq:live  (queue round trip)');
  } else if (verdict === 'USABLE WITH WARNINGS') {
    console.log('Verdict: Redis works, but read the WARN lines above before relying on it in production.');
  } else {
    console.log('Verdict: fix the FAIL lines above, then re-run npm run redis:doctor.');
    console.log('Reminder: the API itself keeps running without Redis (fail-open); the worker/queues are what need it.');
  }
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
};

const watchdog = setTimeout(() => {
  console.error('\nRedis doctor timed out (120s) — the Redis endpoint is accepting TCP but not commands.');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

main()
  .catch((error) => {
    // classifySafeReason keeps unexpected errors free of URL material.
    console.error(`\nRedis doctor aborted: ${classifySafeReason(error)}`);
    process.exit(1);
  })
  .then(() => process.exit(process.exitCode || 0));
