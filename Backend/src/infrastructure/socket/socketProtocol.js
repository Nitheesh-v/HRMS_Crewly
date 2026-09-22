// ─────────────────────────────────────────────────────────────────────────────
// Phase 33.1A — SOCKET PROTOCOL (event allowlist + bounded payloads, pure)
//
// The socket path bypasses the Express pipeline, so it must enforce its own
// version of the input laws that `express-validator` + body limits give REST:
//
//   · events are ALLOWLISTED — an unknown event name is ignored, never
//     "handled by the nearest match" (33.5 adds the chat:* family here);
//   · payloads are hard-capped and must be plain objects — a socket command
//     can never smuggle a file/blob/PII dump through the envelope;
//   · parsing never throws into the socket loop: a malformed frame is
//     dropped, because one bad client must not hurt the process (32.11 §34).
//
// Pure module: no I/O, no shared mutable state.
// ─────────────────────────────────────────────────────────────────────────────
import {
  SOCKET_EVENT_TYPES,
  SOCKET_MAX_PAYLOAD_BYTES,
} from './socketConfig.js';

export const isAllowedSocketEventType = (type) =>
  SOCKET_EVENT_TYPES.includes(String(type || ''));

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const serializeSizeBytes = (value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY; // unserializable ⇒ treat as oversized
  }
};

export const isBoundedSocketPayload = (payload) =>
  isPlainObject(payload) && serializeSizeBytes(payload) <= SOCKET_MAX_PAYLOAD_BYTES;

/**
 * Inbound command validation. Returns a normalized { type, data } or null for
 * anything unacceptable (unknown type, non-object, oversized, unserializable).
 * Never throws.
 */
export const parseSocketCommand = (raw) => {
  if (!isPlainObject(raw)) return null;

  const type = String(raw.type || '');

  if (!isAllowedSocketEventType(type)) return null;

  const data = raw.data === undefined ? {} : raw.data;

  if (!isBoundedSocketPayload(data)) return null;

  return { type, data };
};

/**
 * Outbound frame builder — the same allowlist, applied in the other
 * direction, so this module can never emit a product event family that a
 * later unit has not defined yet.
 */
export const buildSocketFrame = ({ type, data = {} } = {}) => {
  if (!isAllowedSocketEventType(type)) {
    throw new Error(`Unknown socket event type: ${type}`);
  }

  if (!isBoundedSocketPayload(data)) {
    throw new Error(
      `Socket payload exceeds the ${SOCKET_MAX_PAYLOAD_BYTES}-byte bound`,
    );
  }

  return { type, data, ts: Date.now() };
};
