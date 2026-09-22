// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.15 — CONFIGURATION & DEPLOYMENT-READINESS TESTS (§102–§107)
//
// Hermetic: synthetic env values only — NO real secrets, NO network.
// Covers: production fail-fast guards, strict parser behavior (booleans/
// bounded integers), config-check CLI behavior (spawned), env-inventory
// drift pin, and production-unsafe configuration guards.
// ═══════════════════════════════════════════════════════════════════════════
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

process.env.NODE_ENV = 'test';

const { validateProductionConfig } = await import('../src/config/env.js');
const { getRedisConfig, parseRedisEnabled } = await import('../src/config/redis.js');
const { parseWorkerConcurrency } = await import('../src/config/queueConfig.js');
const { parseSlowRequestThresholdMs } = await import('../src/infrastructure/observability/observabilityConfig.js');
const { parseRealtimeEnabled } = await import('../src/infrastructure/realtime/realtimeConfig.js');

const BASE = Object.freeze({
  MONGO_URI: 'mongodb://127.0.0.1:27017/synthetic_test_db',
  JWT_SECRET: 'x'.repeat(40),
  NODE_ENV: 'production',
});

// ═══════════════════════════════════════════════════════════════════════════
describe('production configuration guard (§10/§11/§102)', () => {
  test('valid production config passes', () => {
    const verdict = validateProductionConfig(BASE);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });

  test('missing JWT_SECRET fails startup validation (never insecure)', () => {
    const verdict = validateProductionConfig({ ...BASE, JWT_SECRET: undefined });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.startsWith('JWT_SECRET')));
  });

  test('the development default secret is REFUSED in production', () => {
    const verdict = validateProductionConfig({ ...BASE, JWT_SECRET: 'dev_secret_change_me' });
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join(' '), /development default/);
  });

  test('short secrets are refused with the bound named (not the value)', () => {
    const synthetic = 'q'.repeat(8);
    const verdict = validateProductionConfig({ ...BASE, JWT_SECRET: synthetic });
    assert.equal(verdict.ok, false);
    const joined = verdict.errors.join(' ');
    assert.match(joined, /too short/);
    assert.ok(!joined.includes(synthetic), 'secret value never echoed');
  });

  test('missing MONGO_URI fails in production (authoritative state)', () => {
    const verdict = validateProductionConfig({ ...BASE, MONGO_URI: '' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.startsWith('MONGO_URI')));
  });

  test('the production law is gated by the CALLER: env.js only enforces it when NODE_ENV=production', () => {
    // The pure validator is environment-agnostic (one law, one place);
    // env.js applies it ONLY for production so dev defaults survive.
    const strict = validateProductionConfig({ MONGO_URI: BASE.MONGO_URI, JWT_SECRET: 'dev_secret_change_me' });
    assert.equal(strict.ok, false, 'validator itself is unconditional');
    const source = read('src/config/env.js');
    assert.match(source, /if \(env\.NODE_ENV === 'production'\)/, 'gate exists in env.js');
  });

  test('validation errors name variables, never values (§95)', () => {
    const verdict = validateProductionConfig({ ...BASE, JWT_SECRET: 'x'.repeat(3), MONGO_URI: 'mongodb://user:supersecret@host' });
    const text = JSON.stringify(verdict);
    assert.ok(!text.includes('supersecret'), 'MONGO_URI value leaked');
    assert.ok(!text.includes('xxx'), 'JWT value leaked');
  });

  test('server module pins the guard: env.js exits in production on weak config (structural)', () => {
    const source = read('src/config/env.js');
    assert.match(source, /validateProductionConfig/);
    assert.match(source, /process\.exit\(1\)/);
    assert.match(source, /NODE_ENV === 'production'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('strict parsing: booleans and bounded integers (§102)', () => {
  test('REDIS_ENABLED: exact truthy set only', () => {
    assert.equal(parseRedisEnabled('true'), true);
    assert.equal(parseRedisEnabled('YES'), true);
    assert.equal(parseRedisEnabled('1'), true);
    assert.equal(parseRedisEnabled('TRUE '.trim()), true);
    assert.equal(parseRedisEnabled('false'), false);
    assert.equal(parseRedisEnabled('garbage'), false);
    assert.equal(parseRedisEnabled(''), false);
    assert.equal(parseRedisEnabled(undefined), false);
  });

  test('Redis config: disabled is a valid, healthy choice; enabled requires URL', () => {
    const disabled = getRedisConfig({ REDIS_ENABLED: 'false', REDIS_URL: '' });
    assert.equal(disabled.enabled, false);
    const enabledNoUrl = getRedisConfig({ REDIS_ENABLED: 'true', REDIS_URL: '' });
    assert.equal(enabledNoUrl.enabled, true);
    assert.equal(enabledNoUrl.hasUrl, false);
  });

  test('worker concurrency: garbage → default, bounded clamp', () => {
    assert.equal(parseWorkerConcurrency({}), 2);
    assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: 'abc' }), 2);
    assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: '999999' }), 50);
    assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: '0' }), 2);
  });

  test('slow-request threshold and realtime flag keep strict bounds', () => {
    assert.equal(parseSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: 'nope' }), 1500);
    assert.equal(parseSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: '1' }), 100);
    assert.equal(parseRealtimeEnabled({ REALTIME_ENABLED: 'True' }), true);
    assert.equal(parseRealtimeEnabled({ REALTIME_ENABLED: 'on' }), false);
  });

  test('invalid TRUST_PROXY_MODE is refused (32.3 law intact)', async () => {
    const { parseProxyTrustConfig } = await import('../src/config/proxyTrust.js');
    assert.throws(() => parseProxyTrustConfig({ TRUST_PROXY_MODE: 'everything' }), /TRUST_PROXY_MODE/);
    assert.equal(parseProxyTrustConfig({}).mode, 'direct');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('config-check CLI (§21/§22/§105) — spawned, non-network', () => {
  const runCheck = async (env = {}, args = []) => {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['scripts/config-check.js', ...args],
        {
          cwd: backendRoot,
          env: { ...process.env, ...env },
          timeout: 30000,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || String(error.message) };
    }
  };

  test('valid dev config → exit 0, statuses only, no secret VALUES', async () => {
    const mongoUri = 'mongodb://127.0.0.1:27017/synthetic_check';
    const jwt = 'y'.repeat(40);
    const { code, stdout } = await runCheck({ MONGO_URI: mongoUri, JWT_SECRET: jwt, NODE_ENV: 'development' });
    assert.equal(code, 0, stdout + stderr_tail());
    function stderr_tail() {
      return '';
    }
    assert.match(stdout, /MONGO_URI\s+configured/);
    assert.match(stdout, /JWT_SECRET\s+configured/);
    assert.match(stdout, /no network connections were made/);
    assert.ok(!stdout.includes(mongoUri), 'MONGO_URI value leaked into config-check output');
    assert.ok(!stdout.includes(jwt), 'JWT value leaked into config-check output');
  });

  test('missing MONGO_URI → exit 1, variable NAMED, value absent (nothing was set)', async () => {
    const { code, stderr } = await runCheck({ MONGO_URI: '', NODE_ENV: 'development' });
    assert.equal(code, 1);
    assert.match(stderr, /MONGO_URI/);
  });

  test('--production with weak JWT_SECRET → exit 1 with the production law', async () => {
    const { code, stderr } = await runCheck(
      { MONGO_URI: 'mongodb://127.0.0.1:27017/s', JWT_SECRET: 'dev_secret_change_me', NODE_ENV: 'test' },
      ['--production'],
    );
    assert.equal(code, 1);
    assert.match(stderr, /development default/);
  });

  test('--production with a strong secret → exit 0', async () => {
    const { code, stdout } = await runCheck(
      { MONGO_URI: 'mongodb://127.0.0.1:27017/s', JWT_SECRET: 'z'.repeat(40), NODE_ENV: 'test' },
      ['--production'],
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /--production validation/);
  });

  test('REDIS_ENABLED=true without URL → exit 1 (misconfig, not silent degrade)', async () => {
    const { code, stderr } = await runCheck(
      { MONGO_URI: 'mongodb://127.0.0.1:27017/s', REDIS_ENABLED: 'true', REDIS_URL: '' },
    );
    assert.equal(code, 1);
    assert.match(stderr, /REDIS_URL/);
  });

  test('invalid TRUST_PROXY_MODE → exit 1 naming the variable', async () => {
    const { code, stderr } = await runCheck(
      { MONGO_URI: 'mongodb://127.0.0.1:27017/s', TRUST_PROXY_MODE: 'nonsense' },
    );
    assert.equal(code, 1);
    assert.match(stderr, /TRUST_PROXY/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('environment inventory drift pin (§103/§99) — tolerant, deployment-confidence', () => {
  test('critical deployment names exist in .env.example (never drift silently)', () => {
    const example = read('.env.example');
    const critical = [
      'NODE_ENV', 'PORT', 'MONGO_URI', 'CLIENT_URL', 'JWT_SECRET', 'JWT_EXPIRES_IN',
      'REDIS_ENABLED', 'REDIS_URL', 'BULLMQ_PREFIX', 'FIELD_ENCRYPTION_KEY',
      'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET',
      'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'REALTIME_ENABLED', 'TRUST_PROXY_MODE',
      'OBSERVABILITY_SLOW_REQUEST_MS', 'WORKER_CONCURRENCY',
    ];
    const missing = critical.filter((name) => !example.includes(name));
    assert.deepEqual(missing, [], `.env.example drifted: missing ${missing.join(', ')}`);
  });

  test('.env.example contains placeholders only — no real-looking secrets', () => {
    const example = read('.env.example');
    assert.ok(!/mongodb(\+srv)?:\/\/[^\s]*:[^\s]*@/.test(example.replace(/#\s*[^\n]*/g, '')), 'no real connection strings');
    assert.ok(!/JWT_SECRET=.{32,}/.test(example.replace(/#\s*[^\n]*/g, '')), 'no real JWT secret committed');
  });

  test('.env remains gitignored (§8)', () => {
    const gitignore = read('../.gitignore');
    assert.match(gitignore, /\.env/);
    assert.match(gitignore, /!\.env\.example/);
  });

  test('no backend secret is exposed as a VITE_ variable (§9)', () => {
    const frontendDir = path.join(backendRoot, '..', 'Frontend', 'src');
    const forbidden = /VITE_(MONGO_URI|REDIS_URL|JWT_SECRET|FIELD_ENCRYPTION_KEY|SMTP|CLOUDINARY_API_SECRET|RAZORPAY)/;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
          if (forbidden.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk(frontendDir);
    assert.deepEqual(offenders, [], `secret VITE variables found: ${offenders.join(', ')}`);
  });

  test('frontend runtime config is intentionally public only', () => {
    const allowed = new Set(['VITE_API_URL', 'VITE_MAX_RESUME_SIZE_MB']);
    const frontendDir = path.join(backendRoot, '..', 'Frontend', 'src');
    const found = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx)$/.test(entry.name)) {
          for (const match of fs.readFileSync(full, 'utf8').matchAll(/import\.meta\.env\.(VITE_[A-Z_0-9]+)/g)) {
            found.add(match[1]);
          }
        }
      }
    };
    walk(frontendDir);
    for (const name of found) {
      assert.ok(allowed.has(name), `new VITE_ variable "${name}" must be reviewed as intentionally public`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('process types & rollout safety (§23/§30/§34/§66/§67/§107) — structural pins', () => {
  test('deterministic non-watch start commands exist for API and Worker', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.scripts.start, 'node src/server.js', 'API production start (no watcher)');
    assert.equal(pkg.scripts.worker, 'node src/workers/index.js', 'Worker production start');
    assert.equal(pkg.scripts.dev, 'nodemon src/server.js', 'dev command untouched');
    assert.equal(pkg.scripts['config:check'], 'node scripts/config-check.js');
  });

  test('no destructive index maintenance anywhere (syncIndexes/dropIndex)', () => {
    for (const rel of ['src', 'scripts']) {
      const dir = path.join(backendRoot, rel);
      const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.js')) {
            const content = fs.readFileSync(full, 'utf8');
            assert.doesNotMatch(content, /\bsyncIndexes\s*\(/, `${full} uses destructive syncIndexes`);
            assert.doesNotMatch(content, /dropIndex/, `${full} drops indexes`);
          }
        }
      };
      walk(dir);
    }
  });

  test('worker refuses missing dependencies with NAME-ONLY errors (no URIs)', () => {
    const worker = read('src/workers/index.js');
    assert.match(worker, /REDIS_URL is empty/);
    assert.match(worker, /MONGO_URI is empty/);
    assert.match(worker, /process\.exit\(1\)/);
  });

  test('queue namespace is env-prefixed (staging can never consume prod jobs)', () => {
    const queueConfig = read('src/config/queueConfig.js');
    assert.match(queueConfig, /crewly:\$\{|'crewly:'\s*\+/);
    const realtime = read('src/infrastructure/realtime/realtimeConfig.js');
    assert.match(realtime, /crewly/, 'realtime channel shares the env namespace root');
  });

  test('config-check performs no network I/O (no mongo/redis imports at all)', () => {
    const source = read('scripts/config-check.js');
    assert.doesNotMatch(source, /mongoose\.connect|new Redis\(|nodemailer|axios|fetch\(/, 'pre-flight must stay offline');
  });
});
