// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — REALTIME PROTOCOL (envelope + SSE framing, pure)
//
// Infrastructure-only vocabulary, bounded envelopes, safe framing:
//   · event types are ALLOWLISTED (unknown types are rejected at the
//     publish boundary and ignored at the delivery boundary);
//   · envelopes are hard-capped (4 KB serialized) — realtime never carries
//     files/PII/secrets (§23/§33: those remain HTTP + private object
//     storage);
//   · tenant/user identifiers are 24-hex ObjectIds, server-derived;
//   · channel names are env-namespaced and never carry tokens/PII (§67).
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { REALTIME_EVENT_TYPES, REALTIME_MAX_ENVELOPE_BYTES } from './realtimeConfig.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * Validates + normalizes an outbound event. Throws ApiError-shaped errors
 * via plain Error (callers translate) for: unknown type, bad identity,
 * oversized payload, non-object payload.
 */
export const buildRealtimeEnvelope = ({ type, companyId, userId = null, payload = {} }) => {
  if (!REALTIME_EVENT_TYPES.includes(type)) {
    throw new Error(`Unknown realtime event type: ${type}`);
  }

  if (!OBJECT_ID_PATTERN.test(String(companyId || ''))) {
    throw new Error('Realtime event requires a valid tenant identity');
  }

  if (userId !== null && !OBJECT_ID_PATTERN.test(String(userId || ''))) {
    throw new Error('Realtime event target must be a valid user identity');
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Realtime event payload must be an object');
  }

  const envelope = {
    id: crypto.randomUUID(),
    type,
    companyId: String(companyId),
    userId: userId ? String(userId) : null,
    ts: Date.now(),
    payload,
  };

  const bytes = Buffer.byteLength(JSON.stringify(envelope));

  if (bytes > REALTIME_MAX_ENVELOPE_BYTES) {
    throw new Error(`Realtime event exceeds the ${REALTIME_MAX_ENVELOPE_BYTES}-byte bound`);
  }

  return envelope;
};

/**
 * Delivery-boundary validation: an envelope arriving over pub/sub must
 * re-pass the same law before any local connection sees it. Returns null
 * for anything malformed (never throws — a bad frame must not hurt the
 * process, §34).
 */
export const parseRealtimeEnvelope = (raw) => {
  try {
    const parsed = JSON.parse(String(raw));

    if (!parsed || typeof parsed !== 'object') return null;
    if (!REALTIME_EVENT_TYPES.includes(parsed.type)) return null;
    if (!OBJECT_ID_PATTERN.test(String(parsed.companyId || ''))) return null;
    if (parsed.userId !== null && parsed.userId !== undefined && !OBJECT_ID_PATTERN.test(String(parsed.userId))) return null;
    if (parsed.payload === null || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) return null;
    if (Buffer.byteLength(JSON.stringify(parsed)) > REALTIME_MAX_ENVELOPE_BYTES) return null;

    return {
      id: String(parsed.id || ''),
      type: parsed.type,
      companyId: String(parsed.companyId),
      userId: parsed.userId != null ? String(parsed.userId) : null,
      ts: Number(parsed.ts) || Date.now(),
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
};

/** SSE wire frame: event name + id + bounded JSON data. */
export const formatSseFrame = (envelope) =>
  `event: ${envelope.type}\nid: ${envelope.id}\ndata: ${JSON.stringify(envelope)}\n\n`;

/** Transport heartbeat — a comment frame. Liveness ONLY (never presence). */
export const SSE_HEARTBEAT_FRAME = ':hb\n\n';
