// PHASE 34.2 — the thread panel.
//
// Opens next to the conversation on a desktop, full screen on a phone (a
// 360px drawer on a 390px display is a viewport nobody can use). It shows the
// ROOT message, then the replies newest-first, then a composer.
//
// WHERE THE REPLIES GO: the panel's composer answers the ROOT. The thread is a
// flat, two-level list — replying to a reply keeps the same root — so answering
// the root is the choice that keeps the model honest, and the pill above the
// composer says exactly that. (Replying to a specific message stays available
// from the main view, where the "Reply" action sets the parent explicitly.)
//
// NOTHING HERE IS SURVEILLANCE: opening a thread is a read. There is no
// per-thread read cursor, no follower list, no "seen by" — visibility of new
// replies is derived from what the store already holds, never from a new
// stored field.
//
// It owns no network logic: the page fetches (REST) and sends (socket), the
// store holds the thread, this file renders it.
import { MessagesSquare, X } from 'lucide-react';

import Avatar from './Avatar.jsx';
import MessageComposer from './MessageComposer.jsx';
import ReplyContextPill from './ReplyContextPill.jsx';
import ThreadMessageList from './ThreadMessageList.jsx';
import { hasVisibleText } from '../../utils/chatText.js';
import { timeOf } from '../../utils/chatFormat.js';

const ThreadPanel = ({
  conversationId,
  thread,
  nameOfUserId,
  onClose,
  onLoadOlder,
  onSendReply,
  disabled = false,
  disabledReason = '',
  pendingAttachments = [],
  onAddAttachment,
  onRemoveAttachment,
  loadingOlder = false,
}) => {
  const root = thread?.root ?? null;

  const rootSender = root ? nameOfUserId(root.senderUserId) : '';
  const rootDeleted = Boolean(root?.deletedAt);
  const rootHasBody = hasVisibleText(root?.text);

  return (
    <section className="fixed inset-0 z-30 flex flex-col bg-crewly-bg md:static md:inset-auto md:z-auto md:w-[360px] md:shrink-0 md:border-l md:border-crewly-border">
      <header className="flex items-center gap-2 border-b border-crewly-border px-3 py-2.5">
        <MessagesSquare className="h-4 w-4 shrink-0 text-crewly-green" aria-hidden="true" />

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-crewly-text">Thread</h2>
          <p className="truncate text-[11px] text-crewly-dim">
            {thread
              ? `${thread.items.length} ${thread.items.length === 1 ? 'reply' : 'replies'}${
                  thread.hasMore ? ' shown' : ''
                }`
              : 'Loading…'}
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          title="Close thread"
          className="rounded-lg p-1.5 text-crewly-dim transition hover:bg-crewly-card hover:text-crewly-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* The root, always visible: a thread without its question is noise. */}
      {root && (
        <div className="flex gap-2 border-b border-crewly-border bg-crewly-card/40 p-3">
          <Avatar name={rootSender} seed={root.senderUserId} size="sm" className="mt-0.5" />

          <div className="min-w-0 flex-1">
            <p className="flex items-baseline gap-2">
              <span className="truncate text-[11px] font-semibold text-crewly-text">
                {rootSender}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-crewly-dim">
                {timeOf(root.createdAt)}
              </span>
            </p>

            {rootDeleted ? (
              <p className="mt-0.5 text-xs italic text-crewly-dim">This message was deleted</p>
            ) : (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-crewly-text">
                {rootHasBody ? root.text : 'This message could not be displayed'}
              </p>
            )}

            {!rootDeleted && (root.attachments ?? []).length > 0 && (
              <p className="mt-0.5 text-[11px] text-crewly-dim">
                {(root.attachments ?? []).length === 1
                  ? 'Attachment'
                  : `${root.attachments.length} attachments`}
              </p>
            )}

            <p className="mt-1 text-[10px] text-crewly-dim">
              {(root.threadReplyCount ?? 0) === 1
                ? '1 reply in this thread'
                : `${root.threadReplyCount ?? 0} replies in this thread`}
            </p>
          </div>
        </div>
      )}

      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto">
        <ThreadMessageList
          items={thread?.items ?? []}
          nameOfUserId={nameOfUserId}
          status={thread?.status ?? 'idle'}
          error={thread?.error ?? ''}
          hasMore={Boolean(thread?.hasMore)}
          onOlder={onLoadOlder}
          loadingOlder={loadingOlder}
        />
      </div>

      {root && (
        <div className="border-t border-crewly-border">
          <div className="px-2.5 pt-2.5 sm:px-3">
            <ReplyContextPill
              senderName={rootSender}
              snippet={rootDeleted || !rootHasBody ? null : root.text}
            />
          </div>

          <MessageComposer
            disabled={disabled}
            disabledReason={disabledReason}
            onSend={onSendReply}
            conversationId={conversationId}
            pendingAttachments={pendingAttachments}
            onAddAttachment={onAddAttachment}
            onRemoveAttachment={onRemoveAttachment}
          />
        </div>
      )}
    </section>
  );
};

export default ThreadPanel;
