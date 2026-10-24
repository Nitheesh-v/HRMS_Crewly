// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — REALTIME CONFIGURATION (infrastructure/realtime)
//
// Infrastructure-only realtime foundation (SSE + HTTP commands). Minimum
// configuration per law: ONE enablement flag; every safety bound is
// code-owned (product safety bounds do not belong in env, §60/§72).
//
// Default DISABLED: 32.11 ships infrastructure before product consumers —
// production must not open connections nobody uses. Enable on localhost
// with $env:REALTIME_ENABLED="true" (explicit parse, never Boolean(env)).
// ─────────────────────────────────────────────────────────────────────────────

export const parseRealtimeEnabled = (source = process.env) =>
  String(source?.REALTIME_ENABLED || '').trim().toLowerCase() === 'true';

// Code-owned bounds (product safety constants — not operator tuning).
export const REALTIME_HEARTBEAT_MS = 15_000;
export const REALTIME_TICKET_TTL_SECONDS = 30;
export const REALTIME_MAX_ENVELOPE_BYTES = 4096;
export const REALTIME_MAX_STREAMS_PER_PROCESS = 500;
export const REALTIME_MAX_STREAMS_PER_USER = 5; // multi-device, bounded

// Bounded realtime vocabulary: infrastructure events plus the existing
// data-less Helpdesk notification invalidation event. All other product
// event families remain on their established transports/contracts.
export const REALTIME_EVENT_TYPES = Object.freeze([
  'connection:ready',
  'system:ping',
  'realtime:proof',
  'helpdesk:notifications:changed',
]);

// Env-namespaced channel + ticket keys (same prefix law as queues/heartbeat:
// `crewly:<env>`). Tenant/user identifiers never appear in channel names —
// routing happens inside each instance against its local registry.
export const realtimeChannelName = (prefix = 'crewly:development') =>
  `${prefix}:realtime:events`;

export const realtimeTicketKey = (prefix, ticket) =>
  `${prefix}:realtime:ticket:${ticket}`;
