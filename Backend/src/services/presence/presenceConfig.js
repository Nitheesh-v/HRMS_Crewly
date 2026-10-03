// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE DOMAIN CONSTANTS
//
//  THE SINGLE SOURCE OF TRUTH for Phase 37 enums. Every validator, validator
//  chain, model enum, frontend service and frontend catalog reads from this
//  file. A presence value that exists here and nowhere else is a coding
//  error; a value used in code but missing here is a drift bug.
//
//  WHAT THIS PHASE OWNS
//    · the 5 COMMUNICATION presence values (available/busy/dnd/away/offline)
//    · the 3 work-location values (office/wfh/remote)
//    · the 3 WFH policies (self_declare / approval_required / disabled)
//    · the 4 derived states reserved for Phase 37.6 / 37.4 (on_leave /
//      outside_working_hours / unknown — never selectable by a client)
//    · a few bounded numeric limits (160-char status, 7-day max expiry)
//
//  WHAT THIS PHASE DOES NOT OWN (deliberate absences)
//    · No "attendance presence" vocabulary — that lives in
//      services/attendance/attendancePresenceRules.js (Phase 31.9) and
//      uses WORKING / ON_BREAK / COMPLETED / ON_LEAVE / HOLIDAY /
//      WEEKLY_OFF / NOT_IN. Presence in this file is about communication
//      availability, never about attendance. Reusing those enums here
//      would silently couple the two and is forbidden by Phase 37
//      §13 (PRESENCE IS NOT ATTENDANCE).
//    · No heartbeat / activity TTL / realtime state. Phase 37.4 owns it.
//    · No category list / language list — those belong to Phase 36 AI.
// ═══════════════════════════════════════════════════════════════════════════

// Communication availability values that exist in the resolver's vocabulary.
// NOTE: this is the union of all PRESENCE values the resolver may emit —
// including the system-derived ones (away / offline / on_leave /
// outside_working_hours / unknown). Frontend and validators must NEVER
// accept these from a client body.
export const PRESENCE_VALUES = Object.freeze([
  'available',
  'busy',
  'dnd',
  'away',
  'offline',
  'on_leave',
  'outside_working_hours',
  'unknown',
]);

// The only values a CLIENT is allowed to choose manually. away / offline /
// on_leave / outside_working_hours / unknown are system-derived and
// cannot be manually selected (Phase 37 §3).
export const PRESENCE_MANUAL_VALUES = Object.freeze([
  'available',
  'busy',
  'dnd',
]);

// Display order for the availability menu / chips. Manual first so the
// "what you can pick" group is visually first; derived states are not
// exposed as chips in 37.2 — the resolver surfaces them, not the picker.
export const PRESENCE_MANUAL_DISPLAY_ORDER = Object.freeze([
  'available',
  'busy',
  'dnd',
]);

// Work-location values. 'wfh' is the policy-gated one (Phase 37.7).
export const WORK_LOCATION_VALUES = Object.freeze(['office', 'wfh', 'remote']);

// WFH policy per tenant. Phase 37.5 will own approval_required end-to-end;
// 37.1 / 37.2 only know that under approval_required, a direct WFH
// declaration is refused with a deterministic policy error.
export const WFH_MODES = Object.freeze([
  'self_declare',
  'approval_required',
  'disabled',
]);

// Maximum length of a status message. Bounded by design: a status message
// is a short plain-text availability hint, not a notes field.
export const STATUS_MESSAGE_MAX_CHARS = 160;

// Maximum allowed duration from now for any future expiry a client supplies.
// Without this, a client could pass `expiresAt` in the year 9999 and lock
// themselves into Busy / DND indefinitely. Seven days is generous for a
// "client call until 3 PM" or "focus time" use case.
export const EXPIRY_MAX_DAYS = 7;

// Defaults that match the Phase 37 overview §21. The PresenceTenantConfig
// schema seeds these on first read for every tenant via
// `upsert: true, setDefaultsOnInsert: true` — same pattern Phase 36 AI
// uses (capsule §4.2). Live realtime UI requires a 37.4 implementation,
// so awayAfterMinutes / offlineAfterMinutes are configuration FOUNDATION
// only — the resolver returns `unknown`, not the binary value, until 37.4
// ships.
export const PRESENCE_TENANT_DEFAULTS = Object.freeze({
  enabled: true,
  employeePresenceVisible: true,
  statusMessagesEnabled: true,
  workLocationEnabled: true,
  wfhMode: 'self_declare',
  awayAfterMinutes: 5,
  offlineAfterMinutes: 15,
  lastSeenVisible: false,
  allowedWorkLocations: Object.freeze(['office', 'wfh', 'remote']),
});

// Cache namespace for tenant config. Phase 37.1 does NOT cache
// (caching is optional and 37.4 will own realtime reads). The constant is
// defined here so 37.3 / 37.4 can reuse the same naming convention and
// key prefix rather than inventing a parallel one.
export const PRESENCE_TENANT_CONFIG_CACHE = Object.freeze({
  namespace: 'presence-config',
  version: 1,
});

// Cache namespace for a per-user durable prefs row. Unused in 37.1; reserved
// for future use. Reads in 37.1 are direct (no Redis).
export const PRESENCE_USER_CACHE = Object.freeze({
  namespace: 'presence-user',
  version: 1,
});

// Pure helpers — exported so the resolver, validator and service share
// one truth without importing each other.
export const isManualPresence = (value) =>
  typeof value === 'string' && PRESENCE_MANUAL_VALUES.includes(value);

export const isWorkLocation = (value) =>
  typeof value === 'string' && WORK_LOCATION_VALUES.includes(value);

export const isWfhMode = (value) =>
  typeof value === 'string' && WFH_MODES.includes(value);

// ───────────────────────────────────────────────────────────────────────
// PHASE 37.4 — REALTIME PRESENCE (live precedence + ephemeral liveness)
//
// WHAT THIS UNIT OWNS
//   · the 4 LIVE presence values (available / away / offline / unknown)
//   · the precedence ranking (lower wins; manual DND/Busy/Available
//     outrank everything automatic; offline outranks unknown)
//   · the heartbeat / activity TTL bounds (the SADD/SREM mechanics
//     sit in presenceLiveStore; the constants live here so the
//     service, the bus and the tests share one source of truth)
//   · the Socket.IO namespace path and the strict envelope size cap
//   · the activity throttle window (frontend uses this)
//
// WHAT THIS UNIT DELIBERATELY DOES NOT OWN
//   · No activity timeline (mouse / focus / keystroke history). The
//     activity signal is "recent interaction occurred" only.
//   · No PII. No name, email, status-message text, leave reason, etc.
// ───────────────────────────────────────────────────────────────────────

// The 4 LIVE values the resolver may emit. These NEVER include
// 'dnd' or 'busy' — those are durable-only, decided by the user.
export const PRESENCE_LIVE_STATES = Object.freeze([
  'available',
  'away',
  'offline',
  'unknown',
]);

// Precedence ranking (lower wins; the resolver iterates a user's effective
// state in this order and returns the first non-null value).
//
// 0  manual DND          (durable; outranks everything else)
// 1  manual Busy         (durable; outranks automatic + offline)
// 2  manual Available    (durable; the user explicitly said "Available")
// 3  automatic available (live + recent activity)
// 4  automatic away      (live + recent inactivity past awayAfterMinutes)
// 5  confirmed offline   (no live, no recent activity)
// 6  unknown             (infrastructure cannot determine)
export const PRESENCE_LIVE_PRECEDENCE = Object.freeze({
  'dnd': 0,
  'busy': 1,
  'available': 2, // manual or automatic — resolver decides which input
  'away': 4,
  'offline': 5,
  'unknown': 6,
});

// Whether a presence value is a LIVE value the resolver may derive.
export const isLivePresence = (value) =>
  typeof value === 'string' && PRESENCE_LIVE_STATES.includes(value);

// Heartbeat TTL bounds (seconds). The store applies MAX as a hard cap
// so a misconfigured tenant cannot keep an "online" badge for a year.
export const PRESENCE_HEARTBEAT_TTL_SECONDS_MIN = 30;
export const PRESENCE_HEARTBEAT_TTL_SECONDS_MAX = 300;
export const PRESENCE_HEARTBEAT_TTL_SECONDS_DEFAULT = 60;

// Default grace window the live key is kept alive after the LAST
// connection in the connection set is removed. Allows a reconnect
// that lands on a different instance to read "still alive" without
// a brief "offline" flicker. Mirrors the 37.1 default
// `offlineAfterMinutes` ceiling.
export const PRESENCE_GRACE_TTL_SECONDS_DEFAULT = 30;

// Browser activity throttle. The runtime debounces pointerdown /
// keydown / touchstart into one `presence:activity` socket emit
// at most every PRESENCE_ACTIVITY_THROTTLE_MS.
export const PRESENCE_ACTIVITY_THROTTLE_MS_DEFAULT = 5_000;

// Strict env-namespaced Socket.IO namespace path. The chat socket
// lives at /socket.io (the default); the presence socket rides the
// SAME http server with a NAMESpaced path. CORS / origin rules
// (chat socketConfig) apply identically.
export const PRESENCE_SOCKET_NAMESPACE = '/presence';

// Strict envelope size cap. The publish seam enforces this and
// rejects any envelope that exceeds it. The shape itself is tiny
// (schemaVersion + companyId + userId + presence + presenceSource
// + occurredAt + source) so 512 bytes is plenty of headroom.
export const PRESENCE_MAX_LIVE_ENVELOPE_BYTES = 512;

// Strict env parser. The exact string "true" enables; everything
// else (including unset) is disabled. Matches the 32.11/33.1 law.
export const parsePresenceSocketEnabled = (source = process.env) =>
  String(source?.PRESENCE_SOCKET_ENABLED || '').trim().toLowerCase() === 'true';

// Clamp helper used by both the service (read config) and the
// store (apply TTL). Pure: never throws.
export const clampHeartbeatTtlSeconds = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PRESENCE_HEARTBEAT_TTL_SECONDS_DEFAULT;
  return Math.min(
    PRESENCE_HEARTBEAT_TTL_SECONDS_MAX,
    Math.max(PRESENCE_HEARTBEAT_TTL_SECONDS_MIN, Math.trunc(n)),
  );
};

export const clampGraceTtlSeconds = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PRESENCE_GRACE_TTL_SECONDS_DEFAULT;
  return Math.max(1, Math.min(600, Math.trunc(n)));
};

export const clampActivityThrottleMs = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PRESENCE_ACTIVITY_THROTTLE_MS_DEFAULT;
  return Math.max(500, Math.min(60_000, Math.trunc(n)));
};