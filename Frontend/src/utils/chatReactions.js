// PHASE 34.1 — MESSAGE REACTION VOCABULARY (client mirror of the server enum).
//
// FIXED SET, ON PURPOSE. The server accepts exactly these four types
// (CHAT_REACTION_TYPES in Backend/src/models/ChatMessageReaction.js) and there
// is no free-text or free-emoji path: no picker library, no emoji keyboard, no
// arbitrary string can reach the API. If this list and the server enum ever
// disagree, the server wins and the client gets VALIDATION_ERROR — which is the
// correct failure direction.
//
// Each entry carries the TEXT label the UI must show next to the icon, so the
// control is legible without colour or glyph alone (accessibility), and so the
// product never depends on a font rendering an emoji correctly.

export const CHAT_REACTION_TYPES = ['LIKE', 'HEART', 'LAUGH', 'THANKS'];

export const CHAT_REACTION_LABELS = {
  LIKE: 'Like',
  HEART: 'Heart',
  LAUGH: 'Laugh',
  THANKS: 'Thanks',
};

export const isChatReactionType = (value) => CHAT_REACTION_TYPES.includes(String(value ?? ''));

export const reactionLabel = (type) => CHAT_REACTION_LABELS[type] ?? 'Reaction';
