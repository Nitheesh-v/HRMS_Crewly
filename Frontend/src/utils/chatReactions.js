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

// The GLYPH each type is drawn with.
//
// 34.1 shipped the fixed set with icon-font drawings and the product rule "no
// emojis in new UI". The user then asked for the real emojis to be shown, so
// the presentation changed and the RULE DID NOT: the set is still exactly these
// four types, chosen from a closed list, with no free-emoji input anywhere —
// the emoji is a rendering of a stored enum value, never user input. The
// text label is still rendered next to it in the picker, so the meaning never
// depends on a font or on the reader recognising a glyph.
export const CHAT_REACTION_EMOJI = {
  LIKE: '👍',
  HEART: '❤️',
  LAUGH: '😂',
  THANKS: '🙏',
};

export const reactionEmoji = (type) => CHAT_REACTION_EMOJI[type] ?? '';

export const isChatReactionType = (value) => CHAT_REACTION_TYPES.includes(String(value ?? ''));

export const reactionLabel = (type) => CHAT_REACTION_LABELS[type] ?? 'Reaction';
