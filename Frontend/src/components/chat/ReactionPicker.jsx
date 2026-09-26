// PHASE 34.1 — the reaction picker: four fixed buttons, nothing else.
//
// There is deliberately no text input, no emoji keyboard and no search here.
// The complete vocabulary is CHAT_REACTION_TYPES (four entries), each rendered
// as an icon plus its text label, so the control is usable on touch, by
// keyboard, and by a screen reader.
//
// Behaviour notes:
//   · the popover closes on select, on Escape, and on a click outside;
//   · the trigger is a real button with aria-expanded, so keyboard users are
//     not trapped;
//   · nothing here talks to the network — the parent owns the socket call.
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

import ReactionIcon from './ReactionIcon.jsx';
import { CHAT_REACTION_TYPES, reactionLabel } from '../../utils/chatReactions.js';

const ReactionPicker = ({ onPick, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const wrapper = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (!wrapper.current?.contains(event.target)) setOpen(false);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pick = (type) => {
    setOpen(false);
    onPick(type);
  };

  return (
    <span ref={wrapper} className="relative inline-flex">
      <button
        type="button"
        title="Add a reaction"
        aria-label="Add a reaction"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="rounded p-0.5 transition-colors text-crewly-dim hover:text-crewly-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 disabled:opacity-40"
      >
        <Plus className="h-3 w-3" />
      </button>

      {open && (
        <span
          role="menu"
          aria-label="Reactions"
          className="absolute bottom-5 z-20 flex items-center gap-1 rounded-lg border border-crewly-border bg-crewly-card p-1 shadow-lg"
        >
          {CHAT_REACTION_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              role="menuitem"
              title={reactionLabel(type)}
              aria-label={reactionLabel(type)}
              onClick={() => pick(type)}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-crewly-dim transition-colors hover:bg-crewly-green/10 hover:text-crewly-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40"
            >
              <ReactionIcon type={type} />
              <span>{reactionLabel(type)}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
};

export default ReactionPicker;
