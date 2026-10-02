// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.2 — PRESENCE VISUAL DICTIONARY
//
//  Centralised visual mapping for every value the resolver may emit.
//  Pure, no React. The widget imports the helper and the indicator
//  renders the result. This is the only file in the feature that maps
//  a presence value to a colour / icon name / accessible label, so a
//  later redesign changes one place.
//
//  Colour MUST NOT be the only signal (37.2 §22). Each value carries
//  a label AND a colour AND an icon name AND an aria-label string.
// ═══════════════════════════════════════════════════════════════════════════

const palette = {
  available: {
    label: 'Available',
    color: 'text-emerald-600',
    bg: 'bg-emerald-500',
    ring: 'ring-emerald-500/40',
    dot: 'bg-emerald-500',
    icon: 'circle-check',
    aria: 'Presence: Available',
  },
  busy: {
    label: 'Busy',
    color: 'text-amber-600',
    bg: 'bg-amber-500',
    ring: 'ring-amber-500/40',
    dot: 'bg-amber-500',
    icon: 'minus-circle',
    aria: 'Presence: Busy',
  },
  dnd: {
    label: 'Do Not Disturb',
    color: 'text-rose-600',
    bg: 'bg-rose-500',
    ring: 'ring-rose-500/40',
    dot: 'bg-rose-500',
    icon: 'ban',
    aria: 'Presence: Do Not Disturb',
  },
  away: {
    label: 'Away',
    color: 'text-sky-600',
    bg: 'bg-sky-500',
    ring: 'ring-sky-500/40',
    dot: 'bg-sky-500',
    icon: 'moon',
    aria: 'Presence: Away',
  },
  offline: {
    label: 'Offline',
    color: 'text-slate-500',
    bg: 'bg-slate-400',
    ring: 'ring-slate-400/40',
    dot: 'bg-slate-400',
    icon: 'circle-dashed',
    aria: 'Presence: Offline',
  },
  on_leave: {
    label: 'On Leave',
    color: 'text-violet-600',
    bg: 'bg-violet-500',
    ring: 'ring-violet-500/40',
    dot: 'bg-violet-500',
    icon: 'palm',
    aria: 'Presence: On Leave',
  },
  outside_working_hours: {
    label: 'Outside Working Hours',
    color: 'text-indigo-600',
    bg: 'bg-indigo-500',
    ring: 'ring-indigo-500/40',
    dot: 'bg-indigo-500',
    icon: 'clock',
    aria: 'Presence: Outside Working Hours',
  },
  unknown: {
    // 37.2 §6 — UNKNOWN is not Offline. Distinct label + colour so the
    // widget renders "Presence unavailable", not "Offline".
    label: 'Presence unavailable',
    color: 'text-slate-500',
    bg: 'bg-slate-300',
    ring: 'ring-slate-300/40',
    dot: 'bg-slate-300',
    icon: 'help-circle',
    aria: 'Presence unavailable',
  },
};

export const describePresence = (value) =>
  palette[value] || palette.unknown;

export const presenceLabel = (value) =>
  (palette[value] || palette.unknown).label;

export const isSelectablePresence = (value) =>
  value === 'available' || value === 'busy' || value === 'dnd';

export const presencePalette = palette;