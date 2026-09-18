import mongoose from 'mongoose';
import {
  getLifecycleState,
  getDrainReason,
  isReadyToServe,
} from '../config/lifecycle.js';
import { getRedisHealth } from '../config/redis.js';

// ============================================================
//  PHASE 32.2 — HEALTH CONTROLLERS (thin).
//
//  Contracts (documented in docs/PHASE_32_PRODUCTION_INFRASTRUCTURE.md):
//
//  GET /api/health/live   — LIVENESS. 200 while the process can
//      respond. NEVER checks dependencies (a Redis/SMTP/storage
//      outage must not cause orchestrator restart storms).
//
//  GET /api/health/ready  — READINESS. 200 only when this instance
//      should receive NEW traffic: lifecycle READY + MongoDB
//      reachable (authoritative state). Redis is reported but never
//      flips readiness — Crewly is fail-open/degraded by design.
//      503 during startup, Mongo outage, or drain.
//
//  GET /api/health        — legacy combined probe (Phase 28 shape
//      preserved: status ok/degraded/unhealthy + services block).
//      Status CODE is now honest: 503 when unhealthy (Mongo down).
//
//  Security: bodies carry status labels and safe reason words only —
//  no URIs, hosts, database names, worker ids, or stack traces.
//  Probes are mounted before the audit trail (no per-probe writes)
//  and perform no business queries.
// ============================================================

export const createHealthController = ({
  mongooseState = () => mongoose.connection.readyState,
  redisHealth = getRedisHealth,
  lifecycleState = getLifecycleState,
  drainReason = getDrainReason,
  readyToServe = isReadyToServe,
} = {}) => {
  const MONGO_CONNECTED = 1; // mongoose.Connection.READY_STATES.connected

  const liveness = (req, res) => {
    // Data to frontend - response to frontend
    return res.status(200).json({
      success: true,
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  };

  const readiness = (req, res) => {
    // Data from frontend - nothing (infrastructure probe)

    // DB Logic - cached connection state only (no queries, no I/O)
    const mongoUp = mongooseState() === MONGO_CONNECTED;

    const cache = redisHealth();

    const cacheLabel = cache.status; // 'up' | 'degraded' -> 'down' | 'disabled'

    const ready = readyToServe() && mongoUp;

    // Data to frontend - response to frontend
    if (!ready) {
      const state = lifecycleState();

      const reason = !mongoUp
        ? 'database_unavailable'
        : state === 'STARTING'
          ? 'startup_in_progress'
          : `draining${drainReason() ? `:${drainReason()}` : ''}`;

      return res.status(503).json({
        success: false,
        status: 'unready',
        reason,
        dependencies: {
          database: mongoUp ? 'up' : 'down',
          cache: cacheLabel,
        },
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      success: true,
      status: 'ready',
      dependencies: {
        database: 'up',
        cache: cacheLabel,
      },
      timestamp: new Date().toISOString(),
    });
  };

  // Legacy Phase 28 combined probe — CONTRACT PRESERVED EXACTLY:
  // always HTTP 200, the body `status` field is the signal
  // (ok | degraded | unhealthy). Infrastructure routing decisions use
  // the Phase 32.2 /api/health/ready probe (proper 503 semantics);
  // this endpoint stays byte-compatible for Phase 28 consumers.
  const legacyHealth = (req, res) => {
    // DB Logic - cached connection state only
    const mongodbUp = mongooseState() === 1;

    const redis = redisHealth();

    const status = !mongodbUp
      ? 'unhealthy'
      : redis.status === 'down'
        ? 'degraded'
        : 'ok';

    // Data to frontend - response to frontend
    return res.json({
      success: true,
      message:
        status === 'ok'
          ? 'Crewly HRMS API is healthy'
          : status === 'degraded'
            ? 'Crewly HRMS API is running with degraded infrastructure (Redis unavailable)'
            : 'Crewly HRMS API is unhealthy (MongoDB unavailable)',
      status,
      services: {
        mongodb: mongodbUp ? 'up' : 'down',
        redis: redis.status,
        ...(redis.reason ? { redisReason: redis.reason } : {}),
      },
      timestamp: new Date().toISOString(),
    });
  };

  return { liveness, readiness, legacyHealth };
};

// Default production wiring.
const healthController = createHealthController();

export const liveness = healthController.liveness;
export const readiness = healthController.readiness;
export const legacyHealth = healthController.legacyHealth;

export default healthController;
