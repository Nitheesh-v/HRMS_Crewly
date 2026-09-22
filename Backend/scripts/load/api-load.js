#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.13 — API LOAD RUNNER (read-only scenarios, CLI-only, §63/§80)
//
//   npm run load:api -- --scenario health-read --requests 500 --concurrency 25
//   npm run load:api -- --scenario attendance-presence --ramp 1,10,25,50
//                       --requests 2000 --concurrency 50
//
// SAFETY LAW (§2): this runner physically cannot target production —
// see targetGuard.js (loopback-only by default; exact-host staging
// declaration otherwise; NODE_ENV=production refuses; NO force switch).
//
// All scenarios are READ-ONLY GETs (§82). The generator never retries
// silently (§68), always times out per request (§67), always bounds
// duration AND operation count (§53), and stops cleanly on Ctrl+C
// (§54). Output contains metrics only — never headers/tokens/bodies
// (§86). Results are observations of THIS machine, never capacity
// guarantees (§87/§48) — the disclaimer is printed unconditionally.
// ═══════════════════════════════════════════════════════════════════════════
import '../../src/config/loadEnv.js'; // FIRST — same convention as other scripts
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildRunnerConfig, LIMITS } from './runnerConfig.js';
import { latencySummary, classifyFailure, operationsPerSecond } from './metrics.js';
import { SCENARIOS, isKnownScenario, scenarioNeedsAuth, buildRequestFor } from './scenarios.js';

const runId = `load-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomUUID().slice(0, 6)}`;

const gitHead = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..') })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();

// ── Global abort state (Ctrl+C) ─────────────────────────────────────────────
let globalAbort = false;
const abortControllers = new Set();
const onSignal = () => {
  if (globalAbort) return;
  globalAbort = true;
  console.error('\n⚠ Interrupted — stopping new work, aborting in-flight requests…');
  for (const controller of abortControllers) controller.abort();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

/** One timed request against one target. Returns { ok, statusCode, latencyMs, failureClass }. */
const performRequest = async (baseUrl, request, { token, timeoutMs }) => {
  const controller = new AbortController();
  abortControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        // Auth ONLY via the pre-supplied legitimate token (§70). The
        // value is never logged by this tool anywhere (§86).
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    // Drain the body so sockets return to the pool; never inspect it.
    await response.arrayBuffer().catch(() => {});
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    const ok = response.status < 400; // 4xx = classified failure (expected-4xx is a finding, not a crash)
    return { ok, statusCode: response.status, latencyMs, failureClass: ok ? null : classifyFailure(null, response.status) };
  } catch (error) {
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    if (globalAbort) return { ok: false, statusCode: null, latencyMs, failureClass: 'aborted' };
    return { ok: false, statusCode: null, latencyMs, failureClass: classifyFailure(error, null) };
  } finally {
    clearTimeout(timer);
    abortControllers.delete(controller);
  }
};

const readinessCheck = async (targets, { token, timeoutMs }) => {
  for (const target of targets) {
    const result = await performRequest(target, { path: '/api/health/live', method: 'GET', auth: 'none' }, { token, timeoutMs: Math.min(timeoutMs, 5000) });
    if (!result.ok || result.statusCode !== 200) {
      return { ok: false, target, statusCode: result.statusCode, failureClass: result.failureClass };
    }
  }
  return { ok: true };
};

/** One stage: `quota` operations at `concurrency` against round-robin targets. */
const runStage = async ({ name, quota, concurrency, targets, request, token, timeoutMs }) => {
  const latencies = [];
  const failures = {};
  let success = 0;
  let failed = 0;
  let cursor = 0;
  const stageStarted = performance.now();

  const launchNext = async () => {
    if (globalAbort || cursor >= quota) return;
    const target = targets[cursor % targets.length];
    cursor += 1;
    const result = await performRequest(target, request, { token, timeoutMs });
    if (result.ok) {
      success += 1;
      latencies.push(result.latencyMs);
    } else {
      failed += 1;
      failures[result.failureClass] = (failures[result.failureClass] || 0) + 1;
    }
    await launchNext();
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, quota) }, () => launchNext()),
  );

  const elapsedMs = Math.round(performance.now() - stageStarted);
  const attempted = success + failed;
  return {
    __latencies: latencies, // merged by the caller for overall percentiles
    concurrency,
    requested: quota,
    attempted,
    success,
    failed,
    failures,
    rps: operationsPerSecond(attempted, elapsedMs),
    elapsedMs,
    ...latencySummary(latencies),
  };
};

const printStage = (label, stage) => {
  console.log(
    `  ${label} c=${stage.concurrency} ops=${stage.attempted}/${stage.requested} ok=${stage.success} err=${stage.failed} ` +
      `rps=${stage.rps} p50=${stage.p50}ms p95=${stage.p95}ms p99=${stage.p99}ms max=${stage.max}ms (${stage.elapsedMs}ms)` +
      (Object.keys(stage.failures).length ? ` failures=${JSON.stringify(stage.failures)}` : ''),
  );
};

// ── Main ────────────────────────────────────────────────────────────────────
const main = async () => {
  let config;
  try {
    config = buildRunnerConfig(process.argv.slice(2), {
      defaultTarget: 'http://localhost:5000',
      defaultScenario: 'health-read',
      defaultRequests: 200,
      defaultConcurrency: 10,
    });
  } catch (error) {
    console.error(`✗ REFUSED: ${error.message}`);
    process.exit(2);
  }

  const { scenario, requests, concurrency, ramp, warmup, timeoutMs, durationMs, targets, slug, jsonOut } = config;

  if (!isKnownScenario(scenario)) {
    console.error(`✗ Unknown scenario "${scenario}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  const token = process.env.LOAD_TEST_TOKEN || '';
  if (scenarioNeedsAuth(scenario) && !token) {
    console.error(
      `✗ Scenario "${scenario}" requires a legitimate authenticated session.\n` +
        '  Set it for THIS PowerShell window only:  $env:LOAD_TEST_TOKEN="<token from a normal login>"\n' +
        '  (Name only — never commit or print the value. Remove-Item Env:LOAD_TEST_TOKEN afterwards.)',
    );
    process.exit(2);
  }

  const request = buildRequestFor(scenario, { slug });
  const stages = ramp || [concurrency];
  const quotaPerStage = Math.max(1, Math.floor(requests / stages.length));

  console.log('════════════════════════════════════════════════');
  console.log(`  CREWLY LOAD RUN (read-only) — ${runId}`);
  console.log(`  target(s) : ${targets.join(', ')}`);
  console.log(`  scenario  : ${scenario} — ${SCENARIOS[scenario].description}`);
  console.log(`  auth      : ${scenarioNeedsAuth(scenario) ? 'bearer (LOAD_TEST_TOKEN)' : 'none'}`);
  console.log(`  plan      : ${ramp ? `ramp ${ramp.join('→')}` : `concurrency ${concurrency}`} × ${quotaPerStage} ops/stage (total ≤ ${quotaPerStage * stages.length}), timeout ${timeoutMs}ms`);
  console.log(`  warm-up   : ${warmup} ops (measured separately, excluded from stage percentiles)`);
  console.log(`  git HEAD  : ${gitHead}`);
  console.log('  MUTATION  : NONE — every registered scenario is a GET');
  console.log('════════════════════════════════════════════════');

  const ready = await readinessCheck(targets, { token, timeoutMs });
  if (!ready.ok) {
    console.error(`✗ Readiness failed (${ready.target} → ${ready.statusCode ?? ready.failureClass}). Fix the backend before loading it. Nothing was generated.`);
    process.exit(1);
  }
  console.log('✓ Readiness OK — starting');

  // Warm-up (§39): separate measurement, never silently merged.
  let warmupSummary = null;
  if (warmup > 0) {
    warmupSummary = await runStage({ name: 'warmup', quota: warmup, concurrency: Math.min(5, warmup), targets, request, token, timeoutMs });
    printStage('warm-up', warmupSummary);
  }

  const stageResults = [];
  const globalStarted = performance.now();
  for (const stageConcurrency of stages) {
    if (globalAbort) break;
    const stage = await runStage({ name: scenario, quota: quotaPerStage, concurrency: stageConcurrency, targets, request, token, timeoutMs });
    stageResults.push(stage);
    printStage('stage  ', stage);

    const errorRate = stage.attempted > 0 ? stage.failed / stage.attempted : 0;
    if (errorRate > LIMITS.ERROR_RATE_STOP) {
      console.error(`✗ STOP: error rate ${(errorRate * 100).toFixed(1)}% exceeds the ${(LIMITS.ERROR_RATE_STOP * 100).toFixed(0)}% stop condition — not escalating (§53).`);
      break;
    }
    const stillReady = await readinessCheck(targets, { token, timeoutMs });
    if (!stillReady.ok) {
      console.error('✗ STOP: readiness failed between stages — the backend is not healthy under this load. Treat as a defect finding (§90).');
      break;
    }
    if (durationMs > 0 && performance.now() - globalStarted > durationMs) {
      console.error('✗ STOP: duration budget reached.');
      break;
    }
  }

  // ── Summary (§85) ────────────────────────────────────────────────────────
  const totals = stageResults.reduce(
    (acc, stage) => {
      acc.attempted += stage.attempted;
      acc.success += stage.success;
      acc.failed += stage.failed;
      return acc;
    },
    { attempted: 0, success: 0, failed: 0 },
  );
  const elapsedTotalMs = Math.round(performance.now() - globalStarted);

  console.log('──────────────────────────────────────────────');
  console.log(`  Scenario   : ${scenario}`);
  console.log(`  Target(s)  : ${targets.join(', ')}`);
  console.log(`  Operations : ${totals.attempted} (success ${totals.success} / failed ${totals.failed})`);
  console.log(`  RPS        : ${operationsPerSecond(totals.attempted, elapsedTotalMs)}`);
  const overall = latencySummary(stageResults.flatMap((stage) => stage.__latencies || []));
  console.log(`  Latency    : p50=${overall.p50}ms p95=${overall.p95}ms p99=${overall.p99}ms (mean ${overall.mean}ms, max ${overall.max}ms)`);
  console.log(`  Wall time  : ${elapsedTotalMs}ms`);
  console.log(`  Run ID     : ${runId} (git ${gitHead})`);
  console.log('  These measurements apply to the TESTED environment only —');
  console.log('  they are NOT a production capacity guarantee (§87).');
  console.log('──────────────────────────────────────────────');

  if (jsonOut) {
    const resultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../logs/load-results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const payload = {
      runId,
      gitHead,
      startedAt: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      targets,
      scenario,
      mutating: false,
      requestsPlanned: requests,
      ramp: ramp || [concurrency],
      warmup: warmupSummary
        ? { attempted: warmupSummary.attempted, failed: warmupSummary.failed, p50: warmupSummary.p50, p95: warmupSummary.p95 }
        : null,
      stages: stageResults.map(({ __latencies, ...rest }) => rest),
      overall,
      totals,
      elapsedTotalMs,
      datasetNote: 'dataset scale not captured by the runner — record it in the run notes (§33)',
      disclaimer: 'Measurements apply to the tested environment only; not a production capacity guarantee.',
    };
    const file = path.join(resultsDir, `${runId}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    console.log(`  JSON saved : ${file}`);
  }

  process.exitCode = totals.failed > 0 && totals.success === 0 ? 1 : 0;
  process.exit(process.exitCode);
};

main().catch((error) => {
  console.error(`✗ Load run failed: ${String(error?.message || 'unknown error').slice(0, 200)}`);
  process.exit(1);
});
