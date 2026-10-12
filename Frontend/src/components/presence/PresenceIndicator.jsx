// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.2 — PRESENCE INDICATOR (display only)
//
//  A small dot + label that shows the caller's current effective presence.
//  Has no buttons and dispatches nothing — the parent (the menu button in
//  the header) owns the affordance. The indicator's only job is to read
//  from Redux and render.
//
//  Accessible: colour is NOT the only signal (37.2 §22). The aria-label
//  always names the state. The dot has an `aria-hidden="true"` because
//  the visible label carries the same information.
// ═══════════════════════════════════════════════════════════════════════════

import { CircleHelp, CircleCheck, MinusCircle, Ban, Moon, CircleDashed, Palmtree, Clock } from 'lucide-react';
import { describePresence } from './presenceVisual.js';

const ICONS = {
  'circle-check': CircleCheck,
  'minus-circle': MinusCircle,
  ban: Ban,
  moon: Moon,
  'circle-dashed': CircleDashed,
  palm: Palmtree,
  clock: Clock,
  'help-circle': CircleHelp,
};

export default function PresenceIndicator({
  presence: presenceValue,
  size = 'sm',
  showLabel = true,
  className = '',
}) {
  const visual = describePresence(presenceValue);
  const Icon = ICONS[visual.icon] || CircleHelp;
  const dotSize = size === 'xs' ? 'h-1.5 w-1.5' : size === 'lg' ? 'h-3 w-3' : 'h-2 w-2';
  const textSize = size === 'lg' ? 'text-sm' : 'text-xs';

  return (
    <span
      role="status"
      aria-label={visual.aria}
      className={`inline-flex items-center gap-1.5 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block rounded-full ${visual.dot} ${dotSize}`}
      />
      <Icon
        aria-hidden="true"
        className={`${visual.color} ${size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'}`}
      />
      {showLabel ? (
        <span className={`${textSize} font-medium ${visual.color}`}>
          {visual.label}
        </span>
      ) : null}
    </span>
  );
}