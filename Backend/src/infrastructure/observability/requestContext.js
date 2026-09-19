// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — REQUEST CONTEXT (safe request/correlation IDs + ALS)
//
// REQUEST ID  — one HTTP request. Server-generated (crypto.randomUUID)
//   when the client sends none. A client-provided X-Request-ID is
//   accepted ONLY under a strict contract: 8–64 chars of
//   [A-Za-z0-9_-] — anything malformed, overlong, or containing
//   control characters/PII-ish separators is REPLACED by a server ID.
//   The ID carries NO authorization meaning — it is diagnostics only.
//
// CORRELATION ID — a logical operation spanning boundaries (HTTP →
//   queue → worker). Crewly needs exactly ONE such identifier today,
//   so correlationId === requestId at the HTTP boundary and rides
//   into BullMQ jobs as validated opts metadata (see queueFactory).
//   Deliberately NOT a three-ID tracing system (§7 of the 32.12 law).
//
// AsyncLocalStorage (Node built-in — no dependency) propagates ONLY
// this diagnostics context. No business state ever enters the store
// (§52). Queue processors run in the WORKER process — they do NOT
// inherit HTTP async context; they read the stamped job opts instead.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// Inbound ID trust contract: strict format + length. This is a REJECT
// (and replace) policy, not a sanitizer — we never echo untrusted bytes.
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidRequestId = (value) =>
  typeof value === 'string' && REQUEST_ID_PATTERN.test(value);

export const createRequestId = () => randomUUID(); // 36 chars, matches the pattern

const requestStore = new AsyncLocalStorage();

/** Diagnostics-only context of the current async chain (or null). */
export const getRequestContext = () => requestStore.getStore() || null;

/** The current request/correlation ID for this async chain (or null). */
export const getCurrentRequestId = () => requestStore.getStore()?.requestId || null;

/**
 * Express middleware: resolve/issue the request ID, expose it on the
 * request, return it as a safe response header, and wrap the whole
 * request chain in the diagnostics AsyncLocalStorage context.
 */
export const requestIdMiddleware = (req, res, next) => {
  const inbound = req.headers?.['x-request-id'];
  const requestId = isValidRequestId(inbound) ? inbound : createRequestId();

  req.id = requestId;
  // Safe debugging/support contract (§9): the ID is opaque, random or
  // strictly-validated, and grants nothing by itself.
  res.setHeader('X-Request-ID', requestId);

  requestStore.run({ requestId }, () => next());
};
