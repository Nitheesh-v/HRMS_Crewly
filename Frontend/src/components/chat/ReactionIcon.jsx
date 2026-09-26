// PHASE 34.1 — ONE reaction type, ONE icon.
//
// The icons come from the icon set already in the bundle (lucide-react), so
// reactions add no dependency and no font download. The mapping is exhaustive:
// an unknown type falls back to a neutral glyph instead of rendering nothing,
// and the label always comes from the shared vocabulary.
import { Handshake, Heart, PartyPopper, ThumbsUp } from 'lucide-react';

import { reactionLabel } from '../../utils/chatReactions.js';

const ICONS = {
  LIKE: ThumbsUp,
  HEART: Heart,
  LAUGH: PartyPopper,
  THANKS: Handshake,
};

const ReactionIcon = ({ type, className = 'h-3.5 w-3.5' }) => {
  const Icon = ICONS[type] ?? Handshake;

  return <Icon className={className} aria-hidden="true" title={reactionLabel(type)} />;
};

export default ReactionIcon;
