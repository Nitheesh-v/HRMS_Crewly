// PHASE 33.8 — one conversation in the list (unread badge, no presence).
import { MessageSquare, Users } from 'lucide-react';

const ConversationRow = ({ conversation, active, nameOf, onSelect }) => {
  const isDirect = conversation.type === 'DIRECT';
  const title = isDirect
    ? nameOf(conversation)
    : conversation.title || 'Group conversation';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
        active
          ? 'border-crewly-green/60 bg-crewly-card'
          : 'border-transparent hover:border-crewly-border hover:bg-crewly-card'
      }`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-crewly-border bg-crewly-bg text-crewly-dim">
        {isDirect ? <MessageSquare className="h-4 w-4" /> : <Users className="h-4 w-4" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-crewly-text">{title}</span>
        <span className="block truncate text-xs text-crewly-dim">
          {conversation.lastMessagePreview || 'No messages yet'}
        </span>
      </span>

      {(conversation.unreadCount ?? 0) > 0 && (
        <span className="badge shrink-0 bg-crewly-green/15 text-crewly-green">
          {conversation.unreadCount}
        </span>
      )}
    </button>
  );
};

export default ConversationRow;
