// PHASE 33.8 — conversation list pane (unread badges + new conversation).
import { Plus } from 'lucide-react';

import ConversationRow from './ConversationRow.jsx';

const ConversationList = ({ conversations, status, error, activeId, nameOf, onSelect, onNew }) => (
  <aside className="flex h-full w-full flex-col border-r border-crewly-border bg-crewly-bg md:w-80">
    <div className="flex items-center justify-between border-b border-crewly-border px-4 py-3">
      <h2 className="text-sm font-bold uppercase tracking-wide text-crewly-dim">Conversations</h2>
      <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onNew}>
        <Plus className="mr-1 inline h-3.5 w-3.5" />
        New
      </button>
    </div>

    <div className="flex-1 space-y-1 overflow-y-auto p-2">
      {status === 'loading' && <p className="px-3 py-2 text-sm text-crewly-dim">Loading conversations...</p>}
      {status === 'error' && <p className="px-3 py-2 text-sm text-crewly-red">{error || 'Failed to load.'}</p>}
      {status === 'ready' && conversations.length === 0 && (
        <p className="px-3 py-2 text-sm text-crewly-dim">No conversations yet. Start one with New.</p>
      )}
      {conversations.map((conversation) => (
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

export default ConversationList;
