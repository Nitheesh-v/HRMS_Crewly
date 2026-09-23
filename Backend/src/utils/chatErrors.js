// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.6 — STABLE CHAT SOCKET ERROR CODES (single source of truth)
//
//  Every chat socket ACK failure carries one of these codes in `code`, so
//  clients can branch on stable strings instead of human wording. 33.5
//  introduced the first seven; 33.6 adds the edit/delete four.
//
//  SECURITY SHAPE
//    NOT_FOUND_OR_FORBIDDEN deliberately does not distinguish "other tenant"
//    from "not a member" from "no such conversation" — the socket surface
//    must never confirm or deny a conversation's existence to a principal
//    without membership. Ownership failures (editing/deleting someone
//    else's message) surface as MESSAGE_NOT_EDITABLE to a member who can
//    already see the message in history, so nothing new leaks.
// ═══════════════════════════════════════════════════════════════════════════

export const CHAT_SOCKET_ERROR_CODES = Object.freeze({
  // 33.1 / 33.5
  UNAUTHORIZED: 'UNAUTHORIZED',
  FEATURE_UNAVAILABLE: 'FEATURE_UNAVAILABLE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND_OR_FORBIDDEN: 'NOT_FOUND_OR_FORBIDDEN',
  CONVERSATION_DISABLED: 'CONVERSATION_DISABLED',
  RETRYABLE: 'RETRYABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  // 33.6
  CONFLICT_EDIT_VERSION: 'CONFLICT_EDIT_VERSION',
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  MESSAGE_NOT_EDITABLE: 'MESSAGE_NOT_EDITABLE',
  HISTORY_LIMIT_REACHED: 'HISTORY_LIMIT_REACHED',
});
