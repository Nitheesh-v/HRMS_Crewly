// ============================================================
// Phase 28.1 — Redis connectivity check (developer command)
//
//   npm run redis:check
//
// Loads Backend/.env, verifies REDIS_ENABLED/REDIS_URL, opens a
// short-lived dedicated connection, PINGs the server and reports
// PONG. Uses the SAME config factory as the running backend, so
// a green check means the backend will connect with the same
// configuration.
//
// Output is secret-safe: never prints the connection URL, host,
// username, or password — only safe failure categories and URL
// shape diagnostics (length / spaces / scheme prefix).
//
// Exit codes (predictable policy):
//   0 — Redis enabled and PING -> PONG succeeded
//   1 — check could not be completed:
//       Redis disabled / REDIS_URL missing / URL malformed /
//       connection failed
// ============================================================

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Redis from 'ioredis';
import {
  createRedisOptions,
  getRedisConfig,
  classifySafeReason,
} from '../src/config/redis.js';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(backendDir, '.env') });

const REASON_TEXT = {
  auth_failed: 'authentication error — check REDIS_URL privately',
  connection_refused: 'connection refused — check host/port and network',
  dns_resolution_failed: 'DNS resolution failed — check the host in REDIS_URL',
  timeout: 'timed out — check network/firewall/endpoint availability',
  misconfigured: 'REDIS_URL is empty — set it privately in Backend/.env',
  connection_error: 'connection error — see safe classification above',
};

// Prints ONLY non-sensitive shape statistics — never the URL itself.
const reportUrlShape = (url) => {
  console.error(
    `  URL shape: length=${url.length} ` +
      `space=${url.includes(' ')} cr=${url.includes('\r')} ` +
      `atSigns=${(url.match(/@/g) || []).length} ` +
      `prefix="${url.slice(0, 8)}"`
  );
};

const attemptConnect = (instance, timeoutMs) =>
  new Promise((finish) => {
    let settled = false;
    let lastReason = null;
    const done = (ok, reason = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      instance.off('ready', onReady);
      instance.off('error', onError);
      finish({ ok, reason: reason || lastReason || 'timeout' });
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const onReady = () => done(true);
    const onError = (error) => {
      const reason = classifySafeReason(error);
      // Fail immediately for clearly terminal auth errors; remember the
      // last socket error so the timeout reports a useful category.
      lastReason = reason;
      if (reason === 'auth_failed') done(false, reason);
    };
    instance.once('ready', onReady);
    instance.on('error', onError);
  });

const main = async () => {
  const config = getRedisConfig();

  if (!config.enabled) {
    console.log('Redis is disabled (REDIS_ENABLED=false or invalid value).');
    console.log('Connectivity check skipped — enable Redis to run this check.');
    process.exit(1);
  }

  if (!config.hasUrl) {
    console.error(`Redis connectivity check failed: ${REASON_TEXT.misconfigured}`);
    process.exit(1);
  }

  // Safe URL shape validation BEFORE constructing the client.
  // ioredis parses the URL inside its constructor, so a malformed
  // value throws there — we detect it first and explain safely.
  const rawUrl = String(process.env.REDIS_URL).trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    reportUrlShape(rawUrl);
    console.error(
      'Redis connectivity check failed: connection URL could not be parsed.'
    );
    console.error(
      '  Common causes: a space or line break inside the value, a truncated'
    );
    console.error(
      '  copy, or a missing "redis://" / "rediss://" prefix.'
    );
    console.error('  The URL itself is not printed.');
    process.exit(1);
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    console.error(
      `Redis connectivity check failed: unsupported scheme "${parsed.protocol}" — use redis:// or rediss://.`
    );
    process.exit(1);
  }

  if (!parsed.hostname) {
    reportUrlShape(rawUrl);
    console.error('Redis connectivity check failed: connection URL has no host.');
    process.exit(1);
  }

  console.log('Redis configuration detected.');
  console.log('Connecting...');

  let instance;
  try {
    instance = new Redis(rawUrl, {
      ...createRedisOptions('general'),
    });
  } catch (error) {
    reportUrlShape(rawUrl);
    console.error(
      `Redis connectivity check failed: ${error?.code || 'url_parse'} — connection URL was rejected by the client. The URL itself is not printed.`
    );
    process.exit(1);
  }

  try {
    const result = await attemptConnect(instance, config.connectTimeoutMs);

    if (!result.ok) {
      console.error(
        `Redis connectivity check failed: ${REASON_TEXT[result.reason] || 'unknown error'}`
      );
      process.exitCode = 1;
      return;
    }

    console.log('Redis ready.');
    const pong = await instance.ping();
    console.log(`PING -> ${pong}`);
  } catch (error) {
    console.error(
      `Redis connectivity check failed: ${REASON_TEXT[classifySafeReason(error)] || 'unexpected error'}`
    );
    process.exitCode = 1;
  } finally {
    try {
      instance.disconnect();
    } catch {
      /* ignore */
    }
    console.log('Connection closed.');
  }
};

main()
  .catch((error) => {
    console.error(
      `Redis connectivity check failed: unexpected error (${error?.code || 'unknown'})`
    );
    process.exit(1);
  })
  .then(() => {
    process.exit(process.exitCode || 0);
  });
