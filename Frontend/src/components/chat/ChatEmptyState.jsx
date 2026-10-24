// PHASE 33.8 — placeholder when no conversation is open.
// UI pass: it offers the next action instead of only describing the state.
import { ShieldCheck } from 'lucide-react';
import EmptyState from '../common/EmptyState.jsx';

const ChatEmptyState = ({ onNew }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
    <EmptyState
      illustration="chat"
      title="Pick a conversation"
      description="Or start a new one. Messages stay inside your company — read state is your own unread count and nothing else."
      action={
        onNew ? (
          <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={onNew}>
            New conversation
          </button>
        ) : null
      }
    />

    <p className="flex items-center gap-1.5 text-[11px] text-crewly-dim">
      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
      Tenant-private · attachments are auth-gated
    </p>
  </div>
);

export default ChatEmptyState;
