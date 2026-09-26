// PHASE 33.8 — one message. Text renders as a plain React text node only, so
// it can never inject raw HTML. Deleted messages show a placeholder only.
import { Pencil, ShieldAlert, Trash2 } from 'lucide-react';

import AttachmentBubble from './AttachmentBubble.jsx';

const timeOf = (value) =>
  value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

const MessageBubble = ({
  message,
  mine,
  senderName,
  onEdit,
  onDelete,
  canModerate = false,
  locked = false,
}) => {
  const deleted = Boolean(message.deletedAt);

  // 33.9 — a removal is "moderated" when somebody other than the sender
  // tombstoned it. Derived from two ids only; the text is gone by then.
  const removedByModerator =
    deleted &&
    message.deletedByUserId &&
    message.senderUserId &&
    String(message.deletedByUserId) !== String(message.senderUserId);

  // Moderators may remove anybody's message, but never edit one (edit stays
  // sender-only by design) and never while the conversation is locked.
  const showModeratorDelete = canModerate && !mine && !deleted && !locked;
  const showOwnActions = mine && !deleted && !locked;

  return (
    <div className={`group flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[78%] rounded-xl border px-3 py-2 ${
          mine
            ? 'border-crewly-green/40 bg-crewly-green/10'
            : 'border-crewly-border bg-crewly-card'
        }`}
      >
        {!mine && (
          <p className="mb-0.5 text-[11px] font-semibold text-crewly-dim">{senderName}</p>
        )}

        {deleted ? (
          <p className="text-sm italic text-crewly-dim">
            {removedByModerator ? 'Message removed by a moderator' : 'This message was deleted'}
          </p>
        ) : (
          <>
            {(message.attachments ?? []).length > 0 && (
              <div className="mb-1.5 space-y-1.5">
                {(message.attachments ?? []).map((attachment) => (
                  <AttachmentBubble
                    key={String(attachment.attachmentId)}
                    attachment={attachment}
                  />
                ))}
              </div>
            )}
            {message.text && (
              <p className="whitespace-pre-wrap break-words text-sm text-crewly-text">
                {message.text}
              </p>
            )}
          </>
        )}

        <p className="mt-1 flex items-center gap-2 text-[10px] text-crewly-dim">
          <span>{timeOf(message.createdAt)}</span>
          {!deleted && (message.editVersion ?? 0) > 0 && <span>(edited)</span>}
          {showOwnActions && message.type === 'TEXT' && (message.attachments ?? []).length === 0 && (
            <span className="hidden gap-1 group-hover:flex">
              <button
                type="button"
                title="Edit message"
                className="text-crewly-dim hover:text-crewly-green"
                onClick={() => onEdit(message)}
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Delete message"
                className="text-crewly-dim hover:text-crewly-red"
                onClick={() => onDelete(message)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          )}
          {showModeratorDelete && (
            <span className="hidden gap-1 group-hover:flex">
              <button
                type="button"
                title="Remove as moderator"
                className="text-crewly-dim hover:text-crewly-red"
                onClick={() => onDelete(message)}
              >
                <ShieldAlert className="h-3 w-3" />
              </button>
            </span>
          )}
        </p>
      </div>
    </div>
  );
};

export default MessageBubble;
