// PHASE 33.8 — placeholder when no conversation is open.
// UI pass: it offers the next action instead of only describing the state.
import { MessageSquarePlus, ShieldCheck } from 'lucide-react';

const ChatEmptyState = ({ onNew }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
    <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-crewly-border bg-crewly-card text-crewly-dim">
      <MessageSquarePlus className="h-7 w-7" />
    </span>

    <div>
      <p className="text-base font-semibold text-crewly-text">Pick a conversation</p>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-crewly-dim">
        Or start a new one. Messages stay inside your company — read state is
        your own unread count and nothing else.
      </p>
    </div>

    {onNew && (
      <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={onNew}>
        New conversation
      </button>
    )}

    <p className="flex items-center gap-1.5 text-[11px] text-crewly-dim">
      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
      Tenant-private · attachments are auth-gated
    </p>
  </div>
);

export default ChatEmptyState;
