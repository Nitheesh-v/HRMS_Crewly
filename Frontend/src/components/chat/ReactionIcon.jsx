// PHASE 34.1 (presentation updated in 34.4) — ONE reaction type, ONE glyph.
//
// The four fixed types render as EMOJI, at the user's request, instead of the
// icon-font drawings 34.1 shipped. Nothing about the contract changed: the set
// is closed (LIKE/HEART/LAUGH/THANKS), the server stores an enum, and there is
// still no free-emoji input — this file maps a stored value to a character.
//
// ACCESSIBILITY: the glyph is decorative (aria-hidden) and the accessible name
// comes from the shared text label, so a screen reader announces "Like", not a
// character codepoint, and the meaning never depends on the reader's font.
import { reactionEmoji, reactionLabel } from '../../utils/chatReactions.js';

const ReactionIcon = ({ type, className = 'text-[13px] leading-none' }) => (
  <span className={className} role="img" aria-hidden="true" title={reactionLabel(type)}>
    {reactionEmoji(type)}
  </span>
);

export default ReactionIcon;
