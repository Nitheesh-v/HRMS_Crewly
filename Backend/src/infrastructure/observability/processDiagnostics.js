// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — PROCESS DIAGNOSTICS (§42/§43/§44/§45)
//
// Coarse, bounded, built-in-only process health: memory (process.memory
// Usage), CPU delta (process.cpuUsage), uptime, and event-loop lag
// (perf_hooks.monitorEventLoopDelay). A single unref'd sampler interval
// (default 30s) keeps this O(1) forever — never a profiling engine, no
// heap dumps (they may contain secrets/PII and are FORBIDDEN), no
// restart policies (supervisors own restarts).
//
// Import-time side-effect law: the sampler STARTS only via
// startProcessDiagnostics() (called by server.js) and stops via
// stopProcessDiagnostics(); snapshot() works without the sampler
// (event-loop/CPU fields degrade to null).
// ─────────────────────────────────────────────────────────────────────────────
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setInterval as safeInterval } from 'node:timers';
import { randomUUID } from 'node:crypto';

const DEFAULT_SAMPLE_INTERVAL_MS = 30000;
const MIN_SAMPLE_INTERVAL_MS = 5000;
const MAX_SAMPLE_INTERVAL_MS = 300000;

let samplerTimer = null;
let loopMonitor = null;
let lastCpuUsage = null;
let lastSampledAt = null;
let lastEventLoopLagMs = null;
let lastCpuDeltaMs = null;

// Safe instance identifier (§75): random per boot, no hostname/pid/user.
// Operational ONLY — never business ownership, never logged as identity.
const instanceId = `inst-${randomUUID().slice(0, 8)}`;

export const parseProcessSampleIntervalMs = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.OBSERVABILITY_PROCESS_SAMPLE_MS));
  if (!Number.isFinite(parsed)) return DEFAULT_SAMPLE_INTERVAL_MS;
  return Math.min(MAX_SAMPLE_INTERVAL_MS, Math.max(MIN_SAMPLE_INTERVAL_MS, parsed));
};

const sampleOnce = () => {
  if (loopMonitor) {
    const meanNs = loopMonitor.mean;
    lastEventLoopLagMs = Number.isFinite(meanNs) ? Math.round((meanNs / 1e6) * 10) / 10 : null;
    loopMonitor.reset();
  }
  const current = process.cpuUsage();
  if (lastCpuUsage && lastSampledAt) {
    const elapsedMs = Date.now() - lastSampledAt;
    const cpuMs =
      (current.user - lastCpuUsage.user + (current.system - lastCpuUsage.system)) / 1000;
    lastCpuDeltaMs = elapsedMs > 0 ? Math.round((cpuMs / elapsedMs) * 1000) / 1000 : null;
  }
  lastCpuUsage = current;
  lastSampledAt = Date.now();
};

/** Idempotent start (server.js). Never throws; timer never holds the loop open. */
export const startProcessDiagnostics = (intervalMs = parseProcessSampleIntervalMs()) => {
  if (samplerTimer) return { started: true, alreadyRunning: true };
  try {
    loopMonitor = monitorEventLoopDelay({ resolutionMs: 250 });
    loopMonitor.enable();
  } catch {
    loopMonitor = null; // diagnostics must never break the process
  }
  lastCpuUsage = process.cpuUsage();
  lastSampledAt = Date.now();
  samplerTimer = safeInterval(sampleOnce, intervalMs);
  samplerTimer.unref?.();
  return { started: true, alreadyRunning: false, intervalMs };
};

/** Idempotent stop (graceful shutdown). */
export const stopProcessDiagnostics = () => {
  if (samplerTimer) {
    clearInterval(samplerTimer);
    samplerTimer = null;
  }
  if (loopMonitor) {
    try {
      loopMonitor.disable();
    } catch {
      /* already disabled */
    }
    loopMonitor = null;
  }
  lastCpuUsage = null;
  lastSampledAt = null;
};

/**
 * Bounded, secret-free snapshot for the protected diagnostics surface.
 * No heap dumps, no env, no hosts — aggregate numbers only.
 */
export const processDiagnosticsSnapshot = () => {
  const memory = process.memoryUsage();
  return {
    instanceId,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round((memory.rss / 1048576) * 10) / 10,
      heapUsedMb: Math.round((memory.heapUsed / 1048576) * 10) / 10,
      heapTotalMb: Math.round((memory.heapTotal / 1048576) * 10) / 10,
    },
    eventLoopLagMs: lastEventLoopLagMs,
    cpuUtilization: lastCpuDeltaMs,
    samplerActive: Boolean(samplerTimer),
    sampledAt: lastSampledAt ? new Date(lastSampledAt).toISOString() : null,
    monotonicNowMs: Math.round(performance.now()),
  };
};

export const getInstanceId = () => instanceId;
