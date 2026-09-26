// PHASE 34.2 — the rows inside the thread panel.
//
// DELIBERATELY SMALLER THAN MessageBubble. A thread panel is a focused read of
// one conversation branch, so a row shows: who, when, what — plus the reply
// hint when that row answers another row, and read-only reaction pills. There
// is no edit, no delete and no picker here: those actions belong to the main
// view, where the moderation and lock rules are already enforced and visible.
// Read-only pills still show what the thread says, without offering a control
// that a narrow panel is the wrong place to own.
//
// Text is always a React text node. Nothing here can render HTML.
import Avatar from './Avatar.jsx';
import ReactionBar from './ReactionBar.jsx';
import { hasVisibleText } from '../../utils/chatText.js';
import { timeOf } from '../../utils/chatFormat.js';

const ThreadMessageList = ({ items, nameOfUserId, status, error, hasMore, onOlder, loadingOlder }) => {
  if (status === 'loading' && items.length === 0) {
    return <p className="p-4 text-xs text-crewly-dim">Loading replies…</p>;
  }

  if (status === 'error') {
    return <p className="p-4 text-xs text-crewly-red">{error || 'The thread could not be loaded.'}</p>;
  }

  if (items.length === 0) {
    return (
      <p className="p-4 text-xs text-crewly-dim">
        No replies yet. Answer the message to start the thread — everyone in this conversation can
        follow it here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {hasMore && (
        <button
          type="button"
          onClick={onOlder}
          disabled={loadingOlder}
          className="self-center rounded border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-dim hover:text-crewly-text disabled:opacity-50"
        >
          {loadingOlder ? 'Loading…' : 'Load older replies'}
        </button>
      )}

      {items.map((message) => {
        const senderName = nameOfUserId(message.senderUserId);
        const deleted = Boolean(message.deletedAt);
        const hasBody = hasVisibleText(message.text);
        const attachments = message.attachments ?? [];

        return (
          <div key={String(message._id)} className="flex gap-2">
            <Avatar name={senderName} seed={message.senderUserId} size="sm" className="mt-0.5" />

            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2">
                <span className="truncate text-[11px] font-semibold text-crewly-text">
                  {senderName}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-crewly-dim">
                  {timeOf(message.createdAt)}
                </span>
              </p>

              {/* The hint a reply shows about the message it answers. */}
              {!deleted && message.replyTo && (
                <p className="mt-0.5 truncate border-l-2 border-crewly-border pl-2 text-[11px] text-crewly-dim">
                  <span className="font-semibold">
                    {nameOfUserId(message.replyTo.senderUserId)}
                  </span>
                  {message.replyTo.snippet ? `: ${message.replyTo.snippet}` : ' · deleted message'}
                </p>
              )}

              {deleted ? (
                <p className="mt-0.5 text-xs italic text-crewly-dim">
                  {message.deletedByUserId &&
                  message.senderUserId &&
                  String(message.deletedByUserId) !== String(message.senderUserId)
                    ? 'Message removed by a moderator'
                    : 'This message was deleted'}
                </p>
              ) : (
                <div className="mt-0.5">
                  {attachments.length > 0 && (
                    <p className="text-[11px] text-crewly-dim">
                      {attachments.length === 1
                        ? 'Attachment'
                        : `${attachments.length} attachments`}
                    </p>
                  )}
                  {hasBody && (
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-crewly-text">
                      {message.text}
                    </p>
                  )}
                  {!hasBody && attachments.length === 0 && (
                    <p className="text-sm italic text-crewly-dim">
                      This message could not be displayed
                    </p>
                  )}

                  <ReactionBar reactions={message.reactions ?? []} disabled />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ThreadMessageList;
