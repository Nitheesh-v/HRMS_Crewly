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
// username, or password — only safe failure categories.
//
// Exit codes (predictable policy):
//   0 — Redis enabled and PING -> PONG succeeded
//   1 — check could not be completed:
//       Redis disabled / REDIS_URL missing / connection failed
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

  console.log('Redis configuration detected.');
  console.log('Connecting...');

  const instance = new Redis(String(process.env.REDIS_URL).trim(), {
    ...createRedisOptions('general'),
  });

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
  .catch(() => {
    console.error('Redis connectivity check failed: unexpected error');
    process.exit(1);
  })
  .then(() => {
    process.exit(process.exitCode || 0);
  });
