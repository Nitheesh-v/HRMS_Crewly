// PHASE 33.8 — placeholder when no conversation is open.
import { MessageSquare } from 'lucide-react';

const ChatEmptyState = () => (
  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
    <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-crewly-border bg-crewly-card text-crewly-dim">
      <MessageSquare className="h-6 w-6" />
    </span>
    <div>
      <p className="text-sm font-semibold text-crewly-text">Select a conversation</p>
      <p className="mt-1 max-w-xs text-xs text-crewly-dim">
        Messages are tenant-private. Read state shows only your own unread count.
      </p>
    </div>
  </div>
);

export default ChatEmptyState;
