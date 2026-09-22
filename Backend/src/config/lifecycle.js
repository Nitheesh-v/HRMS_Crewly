// ============================================================
//  PHASE 32.2 — PROCESS LIFECYCLE STATE.
//
//  Answers three distinct infrastructure questions:
//
//    LIVENESS  — is this process alive?          (health/live)
//    READINESS — should it receive new traffic?  (health/ready)
//    SHUTDOWN  — is it draining/stopped?         (SIGTERM path)
//
//  This state is INTENTIONALLY PROCESS-LOCAL: API #1 may drain
//  while API #2 stays ready — that is correct for rolling
//  deployments. It must never become shared Mongo/Redis state.
//
//  Forward-only transitions, idempotent transitions (repeated
//  SIGTERM can never resurrect readiness or double-run drain).
// ============================================================

export const LIFECYCLE_STATES = {
  STARTING: 'STARTING',
  READY: 'READY',
  DRAINING: 'DRAINING',
  STOPPED: 'STOPPED',
};

let state = LIFECYCLE_STATES.STARTING;
let drainReason = null;

const RANK = {
  [LIFECYCLE_STATES.STARTING]: 0,
  [LIFECYCLE_STATES.READY]: 1,
  [LIFECYCLE_STATES.DRAINING]: 2,
  [LIFECYCLE_STATES.STOPPED]: 3,
};

const transition = (next, reason = null) => {
  if (RANK[next] <= RANK[state]) return false;

  state = next;

  if (reason) drainReason = reason;

  return true;
};

export const markReady = () => transition(LIFECYCLE_STATES.READY);

export const beginDrain = (reason = 'shutdown') =>
  transition(LIFECYCLE_STATES.DRAINING, reason);

export const markStopped = () => transition(LIFECYCLE_STATES.STOPPED);

export const getLifecycleState = () => state;

export const getDrainReason = () => drainReason;

// The single answer readiness depends on: the process finished
// startup, is not draining/stopped, and (caller adds Mongo state).
export const isReadyToServe = () => state === LIFECYCLE_STATES.READY;

export const isDraining = () =>
  state === LIFECYCLE_STATES.DRAINING || state === LIFECYCLE_STATES.STOPPED;

// Hermetic tests only — production code must never reset this.
export const _resetLifecycleForTests = () => {
  state = LIFECYCLE_STATES.STARTING;
  drainReason = null;
};
