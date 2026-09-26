// PHASE 33.8 — one message. Text renders as a plain React text node only, so
// it can never inject raw HTML. Deleted messages show a placeholder only.
//
// Design notes (UI pass):
//   · consecutive messages from one sender collapse into a group — the avatar
//     and the name appear once, so a burst reads as one voice, not many rows;
//   · the hover-only action buttons are hover-only on DESKTOP only: on touch
//     there is no hover, so they are always present there (a delete button you
//     cannot reach is not a feature);
//   · tombstone rows keep their shape instead of collapsing the bubble.
import { Pencil, ShieldAlert, Trash2 } from 'lucide-react';

import AttachmentBubble from './AttachmentBubble.jsx';
import Avatar from './Avatar.jsx';
import ReactionBar from './ReactionBar.jsx';
import ReactionPicker from './ReactionPicker.jsx';
import { hasVisibleText } from '../../utils/chatText.js';
import { timeOf } from '../../utils/chatFormat.js';

// On md+ the actions fade in on hover/focus; below md they are always shown.
const ACTION_ROW =
  'flex items-center gap-1 text-crewly-dim ' +
  'md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100';

const IconAction = ({ label, onClick, danger = false, children }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    onClick={onClick}
    className={`rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 ${
      danger
        ? 'hover:text-crewly-red focus-visible:text-crewly-red'
        : 'hover:text-crewly-green focus-visible:text-crewly-green'
    }`}
  >
    {children}
  </button>
);

const MessageBubble = ({
  message,
  mine,
  senderName,
  grouped = false,
  onEdit,
  onDelete,
  onReact,
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
  // 33.10-fix2 — a row nothing can be read from (no visible body, no
  // attachment) must not render as a hollow box. Legacy rows written before
  // the visibility rule existed say so instead of looking like a glitch.
  const hasBody = hasVisibleText(message.text);
  const attachments = message.attachments ?? [];
  const empty = !deleted && !hasBody && attachments.length === 0;

  const showModeratorDelete = canModerate && !mine && !deleted && !locked;
  const showOwnActions = mine && !deleted && !locked;
  const hasActions = showOwnActions || showModeratorDelete;

  // 34.1 — reactions. A tombstone shows nothing (the server refuses writes to
  // it and never projects a summary for it), and a locked conversation is
  // read-only, so the picker disappears exactly where the write would fail.
  const reactions = message.reactions ?? [];
  const canReact = Boolean(onReact) && !deleted && !locked;

  const toggleReaction = (type) => {
    const held = reactions.find((reaction) => reaction.type === type && reaction.mine);

    onReact(message, type, held ? 'REMOVE' : 'ADD');
  };

  const edited = !deleted && (message.editVersion ?? 0) > 0;

  return (
    <div className={`group flex gap-2 ${mine ? 'justify-end' : 'justify-start'} ${grouped ? 'mt-0.5' : 'mt-3'}`}>
      {/* Avatar column: reserved for others so bubbles stay aligned in a group. */}
      <div className="w-6 shrink-0 self-end">
        {!mine && !grouped && (
          <Avatar name={senderName} seed={message.senderUserId} size="sm" className="mb-4" />
        )}
      </div>

      <div className={`flex max-w-[80%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {!mine && !grouped && (
          <p className="mb-1 text-[11px] font-semibold text-crewly-dim">{senderName}</p>
        )}

        <div
          className={`border px-3 py-2 shadow-sm ${mine ? 'bubble-mine' : 'bubble-theirs'} ${
            mine
              ? 'border-crewly-green/35 bg-crewly-green/10'
              : 'border-crewly-border bg-crewly-card'
          } ${deleted ? 'border-dashed' : ''}`}
        >
          {deleted ? (
            <p className="flex items-center gap-1.5 text-sm italic text-crewly-dim">
              {removedByModerator ? 'Message removed by a moderator' : 'This message was deleted'}
            </p>
          ) : (
            <>
              {empty && (
                <p className="text-sm italic text-crewly-dim">
                  This message could not be displayed
                </p>
              )}
              {attachments.length > 0 && (
                <div className={`${hasBody ? 'mb-2' : ''} space-y-1.5`}>
                  {attachments.map((attachment) => (
                    <AttachmentBubble
                      key={String(attachment.attachmentId)}
                      attachment={attachment}
                    />
                  ))}
                </div>
              )}
              {hasBody && (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-crewly-text">
                  {message.text}
                </p>
              )}
            </>
          )}

          <div className={`mt-1 flex items-center gap-2 text-[10px] text-crewly-dim ${mine ? 'justify-end' : ''}`}>
            <span className="tabular-nums">{timeOf(message.createdAt)}</span>
            {edited && <span className="rounded bg-crewly-border/60 px-1 py-px font-medium">edited</span>}

            {canReact && (
              <span className={ACTION_ROW}>
                <ReactionPicker onPick={toggleReaction} />
              </span>
            )}

            {hasActions && (
              <span className={ACTION_ROW}>
                {showOwnActions && message.type === 'TEXT' && attachments.length === 0 && (
                  <>
                    <IconAction label="Edit message" onClick={() => onEdit(message)}>
                      <Pencil className="h-3 w-3" />
                    </IconAction>
                    <IconAction label="Delete message" danger onClick={() => onDelete(message)}>
                      <Trash2 className="h-3 w-3" />
                    </IconAction>
                  </>
                )}
                {showModeratorDelete && (
                  <IconAction label="Remove as moderator" danger onClick={() => onDelete(message)}>
                    <ShieldAlert className="h-3 w-3" />
                  </IconAction>
                )}
              </span>
            )}
          </div>
        </div>

        {!deleted && reactions.length > 0 && (
          <ReactionBar
            reactions={reactions}
            disabled={!canReact}
            onToggle={toggleReaction}
          />
        )}
      </div>
    </div>
  );
};

export default MessageBubble;
