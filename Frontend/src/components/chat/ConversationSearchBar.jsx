// PHASE 34.4 — the conversation search input.
//
// Presentation only: the page owns the debounce, the request and the results.
// The bar reports what was typed (and whether to clear it), which keeps the
// network policy in one place instead of two.
//
// The placeholder says what is searched on purpose: "Search in this
// conversation" is the whole contract of v1 — there is no tenant-wide search to
// discover, and a box that looked global would be a promise the product does
// not make.
import { Search, X } from 'lucide-react';

const ConversationSearchBar = ({ value, onChange, onClose, resultCount = null, status = 'idle' }) => (
  <div className="flex items-center gap-2 border-b border-crewly-border bg-crewly-bg px-3 py-2 sm:px-4">
    <Search className="h-3.5 w-3.5 shrink-0 text-crewly-dim" aria-hidden="true" />

    <input
      type="text"
      autoFocus
      value={value}
      maxLength={64}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      placeholder="Search in this conversation"
      aria-label="Search in this conversation"
      className="input h-8 min-w-0 flex-1 py-1.5 text-sm"
    />

    {status === 'ready' && value.trim().length >= 2 && (
      <span className="shrink-0 text-[11px] tabular-nums text-crewly-dim">
        {resultCount === 0 ? 'No matches' : `${resultCount} match${resultCount === 1 ? '' : 'es'}`}
      </span>
    )}

    <button
      type="button"
      onClick={onClose}
      aria-label="Close search"
      title="Close search"
      className="shrink-0 rounded p-1 text-crewly-dim transition-colors hover:text-crewly-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  </div>
);

export default ConversationSearchBar;
