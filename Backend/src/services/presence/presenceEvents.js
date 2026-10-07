// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE EVENT VOCABULARY (pure, no I/O)
//
//  WHAT THIS MODULE IS
//    One source of truth for the wire shape of every presence event
//    crossing the realtime boundary. The bus and the consumer read this
//    file; nobody invents keys ad hoc.
//
//  TWO CHANNELS
//    1. CLIENT → SERVER (presence Socket.IO namespace):
//         presence:heartbeat  — no payload; transport liveness only.
//         presence:activity   — empty payload; server stamps genuine interaction.
//         presence:tick       — no payload; read-only resolver re-evaluation.
//         presence:disconnect — server-internal (NOT a client event).
//    2. SERVER → CLIENT (authenticated /presence Socket.IO namespace):
//         'presence:changed' with buildPresenceChangedEnvelope(...)
//         'presence:invalidated' with buildPresenceInvalidatedEnvelope(...)
//
//  THE BUS ENVELOPE
//    Schema-versioned. The only allowed keys are PRESENCE_ENVELOPE_KEYS;
//    any extra key in a build attempt is a coding error, not a feature.
//    The size is bounded by PRESENCE_MAX_LIVE_ENVELOPE_BYTES so a future
//    schema change cannot accidentally leak large PII into the bus.
//
//  WHAT THIS MODULE IS NOT
//    · NOT a transport (no socket.io, no ioredis, no SSE).
//    · NOT a Redis namespace helper (see presenceKeys.js for that).
//    · NOT a React / Redux helper (the client channel lives in
//      Frontend/src/realtime/presenceChannel.js).
// ═══════════════════════════════════════════════════════════════════════════

import { PRESENCE_MAX_LIVE_ENVELOPE_BYTES } from './presenceConfig.js';

// Inbound events from the client. The server never trusts a client
// to choose a presence value; 'presence:heartbeat', 'presence:activity',
// and 'presence:tick' carry NO presence value — the server derives it.
//   presence:tick  — read-only re-evaluation request (Phase 37.7 §C.3).
//                    The client asks the server to re-resolve now using
//                    the existing lastActivityAt. Does NOT update the
//                    activity timestamp. Does NOT publish unless the
//                    resolver returns a new value (memo-suppressed).
export const PRESENCE_SOCKET_INBOUND_EVENTS = Object.freeze([
  'presence:heartbeat',
  'presence:activity',
  'presence:tick',
]);

// Outbound event type on the bus. The full wire name lives here so a
// renaming search lands on this file.
export const PRESENCE_GATEWAY_EVENT_TYPE = 'presence:changed';

// Phase 37.5 — invalidation envelope. A SEPARATE event type with a
// dedicated, fixed-shape payload (no presence value carried). The
// affected user's runtime refetches its request and presence state;
// authorized team rows converge through the page's batched REST refresh.
// No PII in this envelope.
export const PRESENCE_INVALIDATED_EVENT_TYPE = 'presence:invalidated';

// Schema version. Increment on a backward-incompatible envelope change
// (e.g. a new key consumers must understand). Consumers MUST ignore
// frames with a schemaVersion they do not recognise.
export const PRESENCE_ENVELOPE_SCHEMA_VERSION = 1;

// The ONLY keys the bus envelope may carry. The build helper asserts
// this on every call; the parse helper ignores any extra key (forward
// safety for new optional fields).
export const PRESENCE_ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'companyId',
  'userId',
  'presence',
  'presenceSource',
  'occurredAt',
  'source',
]);

// Phase 37.5 — invalidation envelope keys. Smaller, dedicated set.
export const PRESENCE_INVALIDATED_KEYS = Object.freeze([
  'schemaVersion',
  'companyId',
  'userId',
  'occurredAt',
  'source',
]);

// The ONLY sources that may appear in a bus envelope. Anything else
// is a coding error (asserted at build time).
const VALID_SOURCES = Object.freeze([
  'connect',        // first connect on a previously-unknown user
  'disconnect',     // last qualifying disconnect for the user
  'activity',       // recent activity arrived; the user may have flipped away -> available
  'heartbeat',      // heartbeat alone never publishes (a guard at the handler),
                    //   but the bus still accepts the value for test seams.
  'tick',           // Phase 37.7 — client asked the server to re-resolve now
                    //   (visibility ticker). The resolver may flip away ->
                    //   available (if recent activity) or away -> offline
                    //   (if past threshold) without a new activity signal.
  'resolver',       // the resolver noticed a transition outside the socket path
                    //   (e.g. manual DND lifted via REST; the team page refetches)
  // Phase 37.5 — work-location request decisions. The bus envelope
  // for these is the `presence:invalidated` event (smaller shape);
  // the source is informational.
  'approve',        // a work-location request was approved
  'cancel',         // an approved work-location request was cancelled
  'lease_expiry',   // shared observer expired a stale connection lease; refetch REST authority
]);

const isIsoString = (value) =>
  typeof value === 'string' &&
  // Cheap ISO-8601 sanity check: starts with YYYY-MM-DD and has a T.
  /^\d{4}-\d{2}-\d{2}T/.test(value);

/**
 * Build one bus envelope. Throws a RangeError if a disallowed key is
 * present OR if the produced envelope exceeds the strict size cap.
 * Pure: never reads the network, never imports a transport.
 *
 * @param {Object} input
 * @param {number} [input.schemaVersion=1]
 * @param {string} input.companyId  — server-derived; never client-supplied
 * @param {string} input.userId     — server-derived
 * @param {string} input.presence   — one of PRESENCE_VALUES (the resolver
 *                                    output; manual or automatic)
 * @param {string} input.presenceSource — 'manual' | 'automatic' | 'none'
 * @param {string} input.occurredAt — ISO string; the resolver's `now`
 * @param {string} input.source     — see VALID_SOURCES
 */
export const buildPresenceChangedEnvelope = (input = {}) => {
  if (!input || typeof input !== 'object') {
    throw new TypeError('presence envelope input must be an object');
  }

  const allowed = {
    schemaVersion: Number.isInteger(input.schemaVersion)
      ? input.schemaVersion
      : PRESENCE_ENVELOPE_SCHEMA_VERSION,
    companyId: String(input.companyId || ''),
    userId: String(input.userId || ''),
    presence: String(input.presence || ''),
    presenceSource: String(input.presenceSource || ''),
    occurredAt: String(input.occurredAt || ''),
    source: String(input.source || ''),
  };

  // Strict-shape guard. A drift bug (e.g. someone adds a new key in a
  // call site) is a coding error and must throw, not silently leak.
  const keys = Object.keys(allowed);
  for (const key of keys) {
    if (!PRESENCE_ENVELOPE_KEYS.includes(key)) {
      throw new RangeError(`presence envelope forbids key "${key}"`);
    }
  }

  if (!allowed.companyId || !allowed.userId) {
    throw new RangeError('presence envelope requires server-derived companyId and userId');
  }
  if (!allowed.presence) {
    throw new RangeError('presence envelope requires a non-empty presence value');
  }
  if (!isIsoString(allowed.occurredAt)) {
    throw new RangeError('presence envelope requires an ISO-8601 occurredAt');
  }
  if (!VALID_SOURCES.includes(allowed.source)) {
    throw new RangeError(`presence envelope source must be one of: ${VALID_SOURCES.join(', ')}`);
  }

  const envelope = Object.freeze({
    schemaVersion: allowed.schemaVersion,
    companyId: allowed.companyId,
    userId: allowed.userId,
    presence: allowed.presence,
    presenceSource: allowed.presenceSource,
    occurredAt: allowed.occurredAt,
    source: allowed.source,
  });

  const serialized = JSON.stringify(envelope);
  if (serialized.length > PRESENCE_MAX_LIVE_ENVELOPE_BYTES) {
    // Bounded size: a future schema change cannot accidentally leak
    // a status-message text or an entire presence snapshot. Throw;
    // the publish seam catches and logs.
    throw new RangeError(
      `presence envelope exceeds ${PRESENCE_MAX_LIVE_ENVELOPE_BYTES} bytes (got ${serialized.length})`,
    );
  }

  return { envelope, serialized };
};

/**
 * Parse a raw JSON string into a validated envelope. Returns null on
 * any structural problem (forward-safe: an envelope from a future
 * schema with an extra key is still accepted; an envelope with a
 * schemaVersion the consumer does not know is REJECTED with null so
 * the bus can drop it cleanly).
 */
export const parsePresenceChangedEnvelope = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  // Schema gate. Unknown versions are dropped silently (forward-safe).
  if (parsed.schemaVersion !== PRESENCE_ENVELOPE_SCHEMA_VERSION) return null;

  if (typeof parsed.companyId !== 'string' || !parsed.companyId) return null;
  if (typeof parsed.userId !== 'string' || !parsed.userId) return null;
  if (typeof parsed.presence !== 'string' || !parsed.presence) return null;
  if (typeof parsed.occurredAt !== 'string' || !isIsoString(parsed.occurredAt)) {
    return null;
  }
  if (typeof parsed.source !== 'string' || !VALID_SOURCES.includes(parsed.source)) {
    return null;
  }
  // presenceSource is optional in the wire but expected. Default 'none'.
  const presenceSource =
    typeof parsed.presenceSource === 'string' && parsed.presenceSource
      ? parsed.presenceSource
      : 'none';

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    companyId: parsed.companyId,
    userId: parsed.userId,
    presence: parsed.presence,
    presenceSource,
    occurredAt: parsed.occurredAt,
    source: parsed.source,
  });
};

/**
 * Phase 37.5 — build one `presence:invalidated` envelope. The same
 * shape contract as `buildPresenceChangedEnvelope`, but with a
 * dedicated, smaller field set. Throws a RangeError if a disallowed
 * key is present OR if the produced envelope exceeds the strict size
 * cap. Pure: never reads the network, never imports a transport.
 */
export const buildPresenceInvalidatedEnvelope = (input = {}) => {
  if (!input || typeof input !== 'object') {
    throw new TypeError('invalidation envelope input must be an object');
  }

  const allowed = {
    schemaVersion: Number.isInteger(input.schemaVersion)
      ? input.schemaVersion
      : PRESENCE_ENVELOPE_SCHEMA_VERSION,
    companyId: String(input.companyId || ''),
    userId: String(input.userId || ''),
    occurredAt: String(input.occurredAt || ''),
    source: String(input.source || 'resolver'),
  };

  for (const key of Object.keys(allowed)) {
    if (!PRESENCE_INVALIDATED_KEYS.includes(key)) {
      throw new RangeError(`invalidation envelope forbids key "${key}"`);
    }
  }

  if (!allowed.companyId || !allowed.userId) {
    throw new RangeError(
      'invalidation envelope requires server-derived companyId and userId',
    );
  }
  if (!isIsoString(allowed.occurredAt)) {
    throw new RangeError('invalidation envelope requires an ISO-8601 occurredAt');
  }
  if (!VALID_SOURCES.includes(allowed.source)) {
    throw new RangeError(
      `invalidation envelope source must be one of: ${VALID_SOURCES.join(', ')}`,
    );
  }

  const envelope = Object.freeze({
    schemaVersion: allowed.schemaVersion,
    companyId: allowed.companyId,
    userId: allowed.userId,
    occurredAt: allowed.occurredAt,
    source: allowed.source,
  });

  const serialized = JSON.stringify(envelope);
  if (serialized.length > PRESENCE_MAX_LIVE_ENVELOPE_BYTES) {
    throw new RangeError(
      `invalidation envelope exceeds ${PRESENCE_MAX_LIVE_ENVELOPE_BYTES} bytes (got ${serialized.length})`,
    );
  }

  return { envelope, serialized };
};

/**
 * Phase 37.5 — parse a raw JSON string into a validated invalidation
 * envelope. Returns null on any structural problem (forward-safe).
 */
export const parsePresenceInvalidatedEnvelope = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schemaVersion !== PRESENCE_ENVELOPE_SCHEMA_VERSION) return null;

  if (typeof parsed.companyId !== 'string' || !parsed.companyId) return null;
  if (typeof parsed.userId !== 'string' || !parsed.userId) return null;
  if (typeof parsed.occurredAt !== 'string' || !isIsoString(parsed.occurredAt)) {
    return null;
  }
  if (typeof parsed.source !== 'string' || !VALID_SOURCES.includes(parsed.source)) {
    return null;
  }

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    companyId: parsed.companyId,
    userId: parsed.userId,
    occurredAt: parsed.occurredAt,
    source: parsed.source,
  });
};
