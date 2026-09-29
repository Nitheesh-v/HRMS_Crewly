// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — SHARED CLIENT LIMITS
//
// Mirrors the server's Backend/src/services/ai/aiConfig.js. The server is the
// authority; these constants exist only so the UI can warn BEFORE submitting.
// ═══════════════════════════════════════════════════════════════════════════

/** One message may be 1 to 2000 characters (AI_MESSAGE_MAX_CHARS). */
export const MAX_MESSAGE_CHARS = 2000;

/** The display cap on the conversation shown on screen. */
export const MAX_MESSAGES = 20;

export default { MAX_MESSAGE_CHARS, MAX_MESSAGES };
