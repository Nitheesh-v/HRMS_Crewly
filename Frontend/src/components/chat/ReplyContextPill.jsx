// PHASE 34.2 — "Replying to <name>: <snippet>" above the composer.
//
// Plain text only: the snippet is a server-truncated string rendered as a
// React text node, so a parent message can never inject markup into the
// composer. A parent that was deleted (or has no visible body) shows a neutral
// phrase instead of a snippet — the server sends null rather than the text the
// delete already removed.
import { CornerUpLeft, X } from 'lucide-react';

const ReplyContextPill = ({ senderName, snippet, onCancel }) => {
  const label = senderName || 'a message';

  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-crewly-border bg-crewly-card px-2 py-1.5">
      <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-crewly-green" aria-hidden="true" />

      <p className="min-w-0 flex-1 truncate text-[11px] text-crewly-dim">
        <span className="font-semibold text-crewly-text">Replying to {label}</span>
        {snippet ? (
          <span className="text-crewly-dim">: {snippet}</span>
        ) : (
          <span className="italic text-crewly-dim">: a deleted message</span>
        )}
      </p>

      {/* The panel shows the same pill without a cancel control: there, the
          context IS the panel, and a second "cancel" would close it. */}
      {typeof onCancel === 'function' && (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel reply"
          title="Cancel reply"
          className="shrink-0 rounded p-0.5 text-crewly-dim transition-colors hover:text-crewly-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};

export default ReplyContextPill;
