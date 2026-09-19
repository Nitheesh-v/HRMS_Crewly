// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.13 — LOAD TOOL TESTS (§78/§79)
//
// The load harness itself must be trustworthy before its numbers mean
// anything: target-safety refusals (production can NEVER be contacted —
// refusal is validated on strings only), safe clamps, correct
// percentiles, honest error classification, bounded runs, clean JSON
// output, and zero secret leakage. Runner spawn tests execute against a
// LOCAL MOCK HTTP server (loopback) — they measure the RUNNER, never
// Crewly, and are labeled as such.
// ═══════════════════════════════════════════════════════════════════════════
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const loadDir = path.join(backendRoot, 'scripts', 'load');

const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const { validateTarget, parseTargetUrl, hostOf } = await import('../scripts/load/targetGuard.js');
const { buildRunnerConfig, LIMITS } = await import('../scripts/load/runnerConfig.js');
const {
  percentile,
  latencySummary,
  classifyFailure,
  clampInt,
  operationsPerSecond,
  ERROR_CLASSES,
} = await import('../scripts/load/metrics.js');
const { SCENARIOS, isKnownScenario, scenarioNeedsAuth, buildRequestFor } = await import('../scripts/load/scenarios.js');

// ── Local mock origin (loopback only — this is runner validation) ───────────
const startMockOrigin = ({ healthStatus = 200, scenarioStatus = 200, delayMs = 0 } = {}) =>
  new Promise((resolve) => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      const finish = () => {
        const isHealth = req.url?.startsWith('/api/health');
        res.writeHead(isHealth ? healthStatus : scenarioStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mock: true }));
      };
      if (delayMs > 0) setTimeout(finish, delayMs);
      else finish();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getHits: () => hits }));
  });

const runRunner = async (args, env = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['scripts/load/api-load.js', ...args],
      {
        cwd: backendRoot,
        env: { ...process.env, MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/t', ...env },
        timeout: 60000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || String(error.message) };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
describe('target safety guard (§2/§31/§32/§79) — refusal without contact', () => {
  test('loopback targets are unconditionally safe', () => {
    for (const target of ['http://localhost:5000', 'http://127.0.0.1:5000', 'http://127.9.9.9:8080', 'http://api.localhost:5000']) {
      assert.equal(validateTarget({ target, explicit: false }).ok, true, target);
    }
  });

  test('remote/production-like targets are REFUSED without the exact-host declaration', () => {
    for (const target of ['https://crewly.example.com', 'https://prod.crewly.io', 'http://10.0.0.5:5000', 'https://staging.crewly.dev']) {
      const verdict = validateTarget({ target, explicit: true });
      assert.equal(verdict.ok, false, `${target} must refuse`);
      assert.match(verdict.reason, /confirm-remote-is-safe-staging/);
    }
  });

  test('a remote target runs ONLY with an exact matching staging declaration', () => {
    assert.equal(validateTarget({ target: 'https://staging.crewly.dev', explicit: true, confirmedStagingHost: 'staging.crewly.dev' }).ok, true);
    const mismatch = validateTarget({ target: 'https://prod.crewly.io', explicit: true, confirmedStagingHost: 'staging.crewly.dev' });
    assert.equal(mismatch.ok, false, 'mismatched declaration refuses');
  });

  test('implicit (non-explicit) remote target refuses even with a declaration', () => {
    assert.equal(validateTarget({ target: null, explicit: false, confirmedStagingHost: 'x.example' }).ok, false);
  });

  test('NODE_ENV=production refuses EVERYTHING (belt over braces)', () => {
    assert.equal(validateTarget({ target: 'http://localhost:5000', nodeEnv: 'production' }).ok, false);
  });

  test('malformed targets and non-http protocols refuse', () => {
    assert.equal(validateTarget({ target: 'not-a-url' }).ok, false);
    assert.equal(validateTarget({ target: 'ftp://localhost:5000' }).ok, false);
    assert.equal(parseTargetUrl('http://localhost:5000').error, null);
    assert.equal(hostOf(parseTargetUrl('http://Api.Example.COM/x').url), 'api.example.com');
  });

  test('NO force switch exists anywhere in the load tooling (structural pin)', () => {
    for (const file of fs.readdirSync(loadDir)) {
      const content = fs.readFileSync(path.join(loadDir, file), 'utf8');
      assert.doesNotMatch(content, /--force/, `${file} must not contain a force switch`);
      assert.doesNotMatch(content, /force-production|skipAuth|skip-auth|bypassAuth/i, `${file} must not contain bypass switches`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('runner config clamps (§84)', () => {
  const base = { defaultTarget: 'http://localhost:5000' };

  test('absurd values are clamped to safe maxima', () => {
    const config = buildRunnerConfig(
      ['--requests', '1000000', '--concurrency', '1000000', '--timeout', '999999', '--warmup', '99999', '--duration', '99999999'],
      { ...base, nodeEnv: 'test' },
    );
    assert.equal(config.requests, LIMITS.MAX_REQUESTS);
    assert.equal(config.concurrency, LIMITS.MAX_CONCURRENCY);
    assert.equal(config.timeoutMs, LIMITS.MAX_TIMEOUT_MS);
    assert.equal(config.warmup, LIMITS.MAX_WARMUP);
    assert.equal(config.durationMs, LIMITS.MAX_DURATION_MS);
  });

  test('defaults are SAFE: read-only scenario, small run, loopback', () => {
    const config = buildRunnerConfig([], { defaultTarget: 'http://localhost:5000', defaultScenario: 'health-read', defaultRequests: 200, defaultConcurrency: 10, nodeEnv: 'test' });
    assert.equal(config.scenario, 'health-read');
    assert.equal(config.requests, 200);
    assert.deepEqual(config.targets, ['http://localhost:5000']);
  });

  test('garbage values fall back to defaults (strict parse, §75)', () => {
    const config = buildRunnerConfig(['--requests', 'abc', '--concurrency', 'NaN'], { ...base, nodeEnv: 'test' });
    assert.equal(config.requests, 200);
    assert.equal(config.concurrency, 10);
  });

  test('ramp parses, clamps each stage, caps stage count', () => {
    const config = buildRunnerConfig(['--ramp', '1,10,25,50,60,70,80,90'], { ...base, nodeEnv: 'test' });
    assert.equal(config.ramp.length, LIMITS.MAX_RAMP_STAGES, 'stage count capped');
    assert.deepEqual(config.ramp, [1, 10, 25, 50, 60, 70]);
    const clamped = buildRunnerConfig(['--ramp', '0,999999'], { ...base, nodeEnv: 'test' });
    assert.deepEqual(clamped.ramp, [1, LIMITS.MAX_CONCURRENCY], 'each stage clamped to [1, 200]');
  });

  test('every extra --targets entry passes the same guard', () => {
    try {
      buildRunnerConfig(['--targets', 'http://localhost:5001,https://prod.example.com'], { ...base, nodeEnv: 'test' });
      assert.fail('refused targets entry must throw');
    } catch (error) {
      assert.match(String(error?.message || error), /targets entry refused/, 'refusal reason surfaces');
    }
    const ok = buildRunnerConfig(['--targets', 'http://localhost:5001,http://127.0.0.1:5002'], { ...base, nodeEnv: 'test' });
    assert.equal(ok.targets.length, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('metrics: percentiles, classification, rates (§41/§52/§65/§66)', () => {
  test('nearest-rank percentiles are correct', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(sorted, 50), 50);
    assert.equal(percentile(sorted, 95), 100); // ceil(0.95*10)=10 → 100
    assert.equal(percentile(sorted, 99), 100);
    assert.equal(percentile(sorted, 0), 10);
    assert.equal(percentile([], 50), null, 'empty sample is null, never 0');
  });

  test('latencySummary: full shape with min/max/mean', () => {
    const summary = latencySummary([100, 200, 300]);
    assert.equal(summary.count, 3);
    assert.equal(summary.min, 100);
    assert.equal(summary.max, 300);
    assert.equal(summary.mean, 200);
    assert.equal(summary.p50, 200);
    const empty = latencySummary([]);
    assert.equal(empty.p99, null);
  });

  test('error classification covers the full taxonomy (§52)', () => {
    assert.equal(classifyFailure(null, 429), 'http_429');
    assert.equal(classifyFailure(null, 503), 'http_5xx');
    assert.equal(classifyFailure(null, 404), 'http_4xx');
    assert.equal(classifyFailure({ code: 'ETIMEDOUT' }), 'timeout');
    assert.equal(classifyFailure({ name: 'AbortError' }), 'aborted');
    assert.equal(classifyFailure({ code: 'ECONNREFUSED' }), 'conn_refused');
    assert.equal(classifyFailure({ code: 'ECONNRESET' }), 'network');
    assert.equal(classifyFailure({ code: 'ENOTFOUND' }), 'network');
    assert.equal(classifyFailure(new Error('weird')), 'unknown');
    for (const klass of ERROR_CLASSES) assert.equal(typeof klass, 'string');
  });

  test('classification NEVER reads request configs (secret-safety by construction)', () => {
    const hostile = { config: { headers: { Authorization: 'Bearer synth-token-value' } }, code: 'ECONNREFUSED' };
    assert.equal(classifyFailure(hostile), 'conn_refused');
  });

  test('clampInt + rps helpers', () => {
    assert.equal(clampInt('50', 10, 1, 40), 40);
    assert.equal(clampInt('x', 10, 1, 40), 10);
    assert.equal(operationsPerSecond(100, 2000), 50);
    assert.equal(operationsPerSecond(0, 0), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('scenario registry (§5/§82) — read-only, real routes only', () => {
  test('every scenario is a GET (mutating load is not registrable)', () => {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      assert.equal(scenario.method, 'GET', name);
      assert.equal(typeof scenario.path, 'string', name);
      assert.match(scenario.path, /^\/api\//, name);
    }
  });

  test('registered scenarios match REAL Crewly routes (structural pin against inventing endpoints)', () => {
    const attendance = read('src/routes/attendanceRoutes.js');
    for (const fragment of ['/today/live', '/presence', '/my']) {
      assert.ok(attendance.includes(`'${fragment}'`), `attendance route ${fragment} must exist in the app`);
    }
    const health = read('src/routes/healthRoutes.js');
    assert.match(health, /\/live/);
    const careers = read('src/routes/publicCareerRoutes.js');
    assert.match(careers, /\/jobs/);
  });

  test('auth scenarios are explicit; careers path builder encodes the slug', () => {
    assert.equal(scenarioNeedsAuth('health-read'), false);
    assert.equal(scenarioNeedsAuth('attendance-presence'), true);
    const request = buildRequestFor('careers-jobs', { slug: 'acme corp' });
    assert.equal(request.path, '/api/public/careers/acme%20corp/jobs');
    assert.equal(isKnownScenario('punch-in'), false, 'mutating scenarios cannot exist');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('runner against a LOCAL MOCK (measures the RUNNER, not Crewly)', () => {
  test('bounded success run: counts, percentiles, disclaimer, JSON artifact', async () => {
    const mock = await startMockOrigin({ healthStatus: 200, scenarioStatus: 200 });
    const { code, stdout } = await runRunner([
      '--scenario', 'health-read',
      '--target', `http://127.0.0.1:${mock.port}`,
      '--requests', '30',
      '--concurrency', '5',
      '--warmup', '3',
      '--json',
    ]);
    mock.server.close();

    assert.equal(code, 0, stdout + stderr_tail());
    function stderr_tail() {
      return '';
    }
    assert.match(stdout, /Run ID\s*:/);
    assert.match(stdout, /p50=[\d.]+ms/);
    assert.match(stdout, /NOT a production capacity guarantee/);
    assert.match(stdout, /MUTATION\s*: NONE/);
    assert.ok(mock.getHits() >= 33, `mock saw warmup+run hits (${mock.getHits()})`);

    const resultsDir = path.join(backendRoot, 'logs', 'load-results');
    const files = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir) : [];
    const latest = files.sort().at(-1);
    assert.ok(latest, 'JSON artifact written (gitignored, §72)');
    const payload = JSON.parse(fs.readFileSync(path.join(resultsDir, latest), 'utf8'));
    assert.equal(payload.mutating, false);
    assert.equal(payload.targets.length, 1);
    assert.match(payload.disclaimer, /not a production capacity guarantee/);
    assert.ok(payload.overall.p50 >= 0);
  });

  test('unhealthy target: runner REFUSES to generate load (§93/§90)', async () => {
    const mock = await startMockOrigin({ healthStatus: 503 });
    const { code, stdout, stderr } = await runRunner([
      '--scenario', 'health-read',
      '--target', `http://127.0.0.1:${mock.port}`,
      '--requests', '10',
    ]);
    mock.server.close();
    assert.equal(code, 1);
    assert.match(stderr || stdout, /Readiness failed/);
    assert.ok(mock.getHits() <= 1, 'no load was generated beyond the readiness probe');
  });

  test('auth scenario without token refuses with env-NAME guidance only', async () => {
    const { code, stderr } = await runRunner(['--scenario', 'attendance-presence', '--requests', '5']);
    assert.equal(code, 2);
    assert.match(stderr, /LOAD_TEST_TOKEN/);
    assert.doesNotMatch(stderr, /Bearer [A-Za-z0-9]/, 'no synthetic token value printed');
  });

  test('auth scenario WITH token: token value never reaches output (§86)', async () => {
    const syntheticToken = 'SYNTH-LOAD-TOKEN-abc123secret';
    const mock = await startMockOrigin({ healthStatus: 200, scenarioStatus: 200 });
    const { code, stdout, stderr } = await runRunner(
      ['--scenario', 'attendance-my', '--target', `http://127.0.0.1:${mock.port}`, '--requests', '10', '--concurrency', '5'],
      { LOAD_TEST_TOKEN: syntheticToken },
    );
    mock.server.close();
    assert.equal(code, 0);
    const output = stdout + stderr;
    assert.ok(!output.includes(syntheticToken), 'synthetic token leaked into runner output');
    assert.ok(!output.includes('Bearer SYNTH'), 'auth header shape never printed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('worker + realtime tool pins (§50/§27)', () => {
  test('ops-load-check: production guard, --workers clamp (1–4), scoped obliterate only', () => {
    const source = read('scripts/ops-load-check.js');
    assert.match(source, /REFUSED: NODE_ENV=production/);
    assert.match(source, /Math\.min\(4, Math\.max\(1, flag\('--workers', 1\)\)\)/);
    assert.match(source, /crewly:test:load-\$\{randomUUID/, 'isolated run prefix (§36)');
    assert.match(source, /obliterate/, 'cleanup is queue-scoped obliterate — never FLUSHALL/FLUSHDB');
    // The LAW may be documented in comments; the COMMAND must never execute.
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(codeOnly, /FLUSHALL|FLUSHDB|flushall|flushdb/);
  });

  test('realtime harness: connection cap, memory guard, always closes (§27)', () => {
    const source = read('scripts/load/realtime-load.js');
    assert.match(source, /MAX_CONNECTIONS = 200/);
    assert.match(source, /RSS_GUARD_BYTES/);
    assert.match(source, /SIGINT/, 'Ctrl+C handling present');
    assert.match(source, /state\.close\(\)|body\.cancel\(\)/, 'connections are actively closed');
    assert.match(source, /load:realtime|REALTIME/, 'neutral realtime labeling');
    assert.doesNotMatch(source, /presence:update|message:new|typing:/, 'no product vocabulary');
  });

  test('package scripts exist and point at the new tooling', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.scripts['load:api'], 'node scripts/load/api-load.js');
    assert.equal(pkg.scripts['load:realtime'], 'node scripts/load/realtime-load.js');
    assert.equal(pkg.scripts['ops:load-check'], 'node scripts/ops-load-check.js');
  });
});
