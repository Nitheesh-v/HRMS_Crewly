// PHASE 33.8 — conversation list pane (unread badges + new conversation).
// UI pass: a filter box (a list you cannot search is a list you scroll), a
// real empty state, and skeletons instead of the words "Loading conversations".
import { useMemo, useState } from 'react';
import { Plus, Search, SearchX } from 'lucide-react';

import ConversationRow from './ConversationRow.jsx';

const RowSkeleton = () => (
  <div className="animate-pulse space-y-2 p-1" aria-hidden="true">
    {[0, 1, 2, 3].map((row) => (
      <div key={row} className="flex items-center gap-3 px-2 py-2">
        <div className="h-10 w-10 shrink-0 rounded-full bg-crewly-border/50" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-2/3 rounded bg-crewly-border/50" />
          <div className="h-2.5 w-1/2 rounded bg-crewly-border/30" />
        </div>
      </div>
    ))}
  </div>
);

const ConversationList = ({
  conversations,
  status,
  error,
  activeId,
  nameOf,
  onSelect,
  onNew,
  mobileHidden = false,
}) => {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) return conversations;

    return conversations.filter((conversation) => {
      const title = nameOf(conversation) || '';
      const preview = conversation.lastMessagePreview || '';

      return (
        title.toLowerCase().includes(needle) ||
        preview.toLowerCase().includes(needle)
      );
    });
  }, [conversations, query, nameOf]);

  return (
    <aside
      className={`h-full w-full flex-col border-r border-crewly-border bg-crewly-bg md:flex md:w-80 ${
        mobileHidden ? 'hidden' : 'flex'
      }`}
    >
      <div className="border-b border-crewly-border px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-crewly-text">Messages</h2>
          <button
            type="button"
            className="btn-ghost px-2.5 py-1.5 text-xs"
            onClick={onNew}
            title="Start a new conversation"
          >
            <Plus className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            New
          </button>
        </div>

        <div className="relative mt-2.5">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="input py-2 pl-9 text-sm"
          />
        </div>
      </div>

      <div className="chat-scroll flex-1 space-y-1 overflow-y-auto p-2">
        {status === 'loading' && <RowSkeleton />}

        {status === 'error' && (
          <div className="px-3 py-4 text-center">
            <p className="text-sm text-crewly-red">{error || 'Failed to load conversations.'}</p>
          </div>
        )}

        {status === 'ready' && conversations.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-crewly-border bg-crewly-card text-crewly-dim">
              <Plus className="h-5 w-5" />
            </span>
            <p className="text-sm font-semibold text-crewly-text">No conversations yet</p>
            <p className="text-xs text-crewly-dim">
              Start a direct message or a group to get going.
            </p>
            <button type="button" className="btn-primary mt-1 px-3.5 py-2 text-xs" onClick={onNew}>
              Start a conversation
            </button>
          </div>
        )}

        {status === 'ready' && conversations.length > 0 && visible.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <SearchX className="h-5 w-5 text-crewly-dim" aria-hidden="true" />
            <p className="text-xs text-crewly-dim">
              Nothing matches “{query.trim()}”.
            </p>
          </div>
        )}

        {visible.map((conversation) => (
          <ConversationRow
            key={conversation._id}
            conversation={conversation}
            active={String(activeId) === String(conversation._id)}
            nameOf={nameOf}
            onSelect={() => onSelect(conversation._id)}
          />
        ))}
      </div>
    </aside>
  );
};

export default ConversationList;
