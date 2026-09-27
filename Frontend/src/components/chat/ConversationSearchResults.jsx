// PHASE 34.4 — the search results panel.
//
// One row per match: who wrote it, a bounded snippet with the term marked, when.
// Every string is a React text node — the snippet is user content and is never
// treated as markup.
//
// Clicking a row asks the page to show that message. The page decides HOW (it
// owns the message window); this component only reports the pick.
import { CornerUpLeft, Search } from 'lucide-react';

import { dayLabel, timeOf } from '../../utils/chatFormat.js';

const markTerm = (snippet, term) => {
  const body = String(snippet ?? '');
  const needle = String(term ?? '').trim();

  if (!needle || body.length === 0) return [body];

  const at = body.toLowerCase().indexOf(needle.toLowerCase());

  if (at < 0) return [body];

  return [body.slice(0, at), body.slice(at, at + needle.length), body.slice(at + needle.length)];
};

const ConversationSearchResults = ({
  q,
  items,
  status,
  error,
  hasMore,
  loadingMore,
  nameOfUserId,
  onOpen,
  onLoadMore,
}) => {
  if (status === 'idle' || q.trim().length < 2) {
    return (
      <div className="border-b border-crewly-border bg-crewly-card/40 px-3 py-2 text-[11px] text-crewly-dim sm:px-4">
        Type at least two characters. Search looks at text messages in this conversation only —
        deleted messages are never returned.
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="border-b border-crewly-red/40 bg-crewly-red/10 px-3 py-2 text-xs text-crewly-red sm:px-4">
        {error || 'The search could not be completed.'}
      </div>
    );
  }

  if (status === 'loading' && items.length === 0) {
    return (
      <div className="border-b border-crewly-border bg-crewly-card/40 px-3 py-2 text-[11px] text-crewly-dim sm:px-4">
        Searching…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="border-b border-crewly-border bg-crewly-card/40 px-3 py-2 text-[11px] text-crewly-dim sm:px-4">
        No messages in this conversation match that.
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto border-b border-crewly-border bg-crewly-card/40 chat-scroll">
      <ul className="divide-y divide-crewly-border/60">
        {items.map((row) => {
          const [before, hit, after] = markTerm(row.textSnippet, q);

          return (
            <li key={String(row._id)}>
              <button
                type="button"
                onClick={() => onOpen(row)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-crewly-green/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-crewly-green/40 sm:px-4"
              >
                <Search className="mt-0.5 h-3 w-3 shrink-0 text-crewly-dim" aria-hidden="true" />

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[11px] font-semibold text-crewly-text">
                      {nameOfUserId?.(row.senderUserId) ?? 'Unknown user'}
                    </span>
                    <span className="shrink-0 text-[10px] text-crewly-dim">
                      {dayLabel(row.createdAt)} · {timeOf(row.createdAt)}
                    </span>
                    {row.threadRootMessageId && (
                      <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-crewly-dim">
                        <CornerUpLeft className="h-2.5 w-2.5" aria-hidden="true" /> reply
                      </span>
                    )}
                  </span>

                  <span className="mt-0.5 block truncate text-xs text-crewly-dim">
                    {before}
                    {hit ? <span className="bg-crewly-green/20 font-medium text-crewly-text">{hit}</span> : null}
                    {after}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div className="px-3 py-2 sm:px-4">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="rounded border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-dim hover:text-crewly-text disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more matches'}
          </button>
        </div>
      )}
    </div>
  );
};

export default ConversationSearchResults;
