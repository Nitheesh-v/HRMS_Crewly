// PHASE 33.8 — one conversation in the list (unread badge, no presence).
// UI pass: initials avatar, a time stamp, and an active state that reads as
// "you are here" rather than a slightly different border.
import { Users } from 'lucide-react';

import Avatar from './Avatar.jsx';
import { relativeTime } from '../../utils/chatFormat.js';

const ConversationRow = ({ conversation, active, nameOf, onSelect }) => {
  const isDirect = conversation.type === 'DIRECT';
  const title = isDirect
    ? nameOf(conversation)
    : conversation.title || 'Group conversation';
  const unread = conversation.unreadCount ?? 0;
  const stamp = relativeTime(conversation.lastMessageAt);
  const preview = conversation.lastMessagePreview || 'No messages yet';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={`relative flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
        active
          ? 'border-crewly-green/50 bg-crewly-green/[0.07]'
          : 'border-transparent hover:border-crewly-border hover:bg-crewly-card'
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r bg-crewly-green" />
      )}

      {isDirect ? (
        <Avatar name={title} seed={title} size="lg" />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-crewly-border/40 text-crewly-dim">
          <Users className="h-4 w-4" />
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-sm ${unread > 0 ? 'font-bold text-crewly-text' : 'font-semibold text-crewly-text'}`}>
            {title}
          </span>
          {stamp && (
            <span className={`shrink-0 text-[10px] ${unread > 0 ? 'font-semibold text-crewly-green' : 'text-crewly-dim'}`}>
              {stamp}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={`truncate text-xs ${unread > 0 ? 'text-crewly-text/80' : 'text-crewly-dim'}`}>
            {preview}
          </span>
        </span>
      </span>

      {unread > 0 && (
        <span
          className="badge shrink-0 bg-crewly-green text-crewly-bg"
          aria-label={`${unread} unread`}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
};

export default ConversationRow;
