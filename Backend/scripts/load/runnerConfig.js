// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.13 — RUNNER CONFIG (CLI parsing, safe clamps, §66/§67/§75/§84)
//
// Every knob has a developer-machine-safe maximum. Defaults are SAFE:
// read-only scenario, small request count, loopback target.
// ═══════════════════════════════════════════════════════════════════════════
import { clampInt } from './metrics.js';
import { validateTarget } from './targetGuard.js';

export const LIMITS = Object.freeze({
  MAX_CONCURRENCY: 200,
  MAX_REQUESTS: 20000,
  MAX_DURATION_MS: 5 * 60 * 1000,
  MIN_TIMEOUT_MS: 500,
  MAX_TIMEOUT_MS: 30000,
  MAX_WARMUP: 200,
  MAX_RAMP_STAGES: 6,
  ERROR_RATE_STOP: 0.2, // stage aborts above 20% failures (§53)
  MAX_TARGETS: 4,
});

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
};

/**
 * Build a validated runner config from CLI argv. Throws on safety
 * refusals (production target/env) BEFORE any traffic is generated.
 */
export const buildRunnerConfig = (argv = [], defaults = {}) => {
  const args = parseArgs(argv);

  const target = args.target && args.target !== true ? String(args.target) : defaults.defaultTarget || null;
  const confirmedStagingHost =
    args['confirm-remote-is-safe-staging'] && args['confirm-remote-is-safe-staging'] !== true
      ? String(args['confirm-remote-is-safe-staging'])
      : '';

  const guard = validateTarget({
    target,
    explicit: Boolean(args.target && args.target !== true),
    confirmedStagingHost,
    nodeEnv: args.nodeEnv, // test injection; undefined → process.env
  });
  if (!guard.ok) {
    const error = new Error(guard.reason);
    error.code = 'TARGET_REFUSED';
    throw error;
  }

  const targets = [guard.url.origin];
  if (args.targets && args.targets !== true) {
    for (const extra of String(args.targets).split(',').map((entry) => entry.trim()).filter(Boolean)) {
      const extraGuard = validateTarget({
        target: extra,
        explicit: true,
        confirmedStagingHost,
        nodeEnv: args.nodeEnv,
      });
      if (!extraGuard.ok) {
        const error = new Error(`--targets entry refused: ${extraGuard.reason}`);
        error.code = 'TARGET_REFUSED';
        throw error;
      }
      if (!targets.includes(extraGuard.url.origin) && targets.length < LIMITS.MAX_TARGETS) {
        targets.push(extraGuard.url.origin);
      }
    }
  }

  const rampRaw = args.ramp && args.ramp !== true
    ? String(args.ramp).split(',').map((entry) => clampInt(entry, 0, 1, LIMITS.MAX_CONCURRENCY)).filter(Boolean)
    : [];
  const ramp = rampRaw.slice(0, LIMITS.MAX_RAMP_STAGES);

  return {
    targets,
    scenario: String(args.scenario || defaults.defaultScenario || 'health-read'),
    requests: clampInt(args.requests, defaults.defaultRequests ?? 200, 1, LIMITS.MAX_REQUESTS),
    concurrency: clampInt(args.concurrency, defaults.defaultConcurrency ?? 10, 1, LIMITS.MAX_CONCURRENCY),
    timeoutMs: clampInt(args.timeout, 10000, LIMITS.MIN_TIMEOUT_MS, LIMITS.MAX_TIMEOUT_MS),
    warmup: clampInt(args.warmup, 10, 0, LIMITS.MAX_WARMUP),
    ramp: ramp.length > 0 ? ramp : null,
    durationMs: clampInt(args.duration, 0, 0, LIMITS.MAX_DURATION_MS),
    slug: typeof args.slug === 'string' ? args.slug.slice(0, 64) : 'example-company',
    jsonOut: args.json === true || (args.json && args.json !== 'false'),
    hasToken: Boolean(process.env.LOAD_TEST_TOKEN),
  };
};

export default buildRunnerConfig;
