// PHASE 33.8 — scrollable history. Loads older pages on scroll-up without
// losing position; sticks to the bottom for new arrivals only when the
// reader is already near the bottom.
//
// UI pass: day separators, sender grouping, pending rows that look like the
// message they will become, a skeleton instead of the words "Loading
// history...", and a jump-to-latest control that appears only when the reader
// has scrolled away from the newest message.
import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, MessageSquarePlus } from 'lucide-react';

import MessageBubble from './MessageBubble.jsx';
import { dayKey, dayLabel, shouldGroup } from '../../utils/chatFormat.js';

const Skeleton = () => (
  <div className="animate-pulse space-y-3 py-2" aria-hidden="true">
    <div className="flex justify-start gap-2">
      <div className="h-6 w-6 rounded-full bg-crewly-border/60" />
      <div className="h-10 w-48 rounded-xl bg-crewly-card" />
    </div>
    <div className="flex justify-end">
      <div className="h-8 w-40 rounded-xl bg-crewly-green/10" />
    </div>
    <div className="flex justify-start gap-2">
      <div className="h-6 w-6 rounded-full bg-crewly-border/60" />
      <div className="h-16 w-64 rounded-xl bg-crewly-card" />
    </div>
  </div>
);

const MessageList = ({
  conversationId,
  entry,
  pending,
  meId,
  nameOfUserId,
  onOlder,
  onEdit,
  onDelete,
  onReact,
  canModerate = false,
  locked = false,
}) => {
  const scrollRef = useRef(null);
  const stickToBottom = useRef(true);
  const olderFix = useRef(null);

  // The jump-to-latest control is DERIVED, not synced: the state carries the
  // conversation it belongs to, so opening another room resets it during render
  // (no setState inside an effect, no cascading render).
  const [scrollState, setScrollState] = useState({ conversationId: null, away: false });
  const awayFromBottom = scrollState.conversationId === conversationId && scrollState.away;

  const items = entry?.items ?? [];
  const pendingItems = pending ?? [];

  // New conversation open: land at the newest message. (The derived
  // scrollState above already forgot the previous room's position.)
  useLayoutEffect(() => {
    stickToBottom.current = true;
    olderFix.current = null;
  }, [conversationId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (olderFix.current) {
      // Older page prepended: keep the first visible message where it was.
      el.scrollTop += el.scrollHeight - olderFix.current.height;
      olderFix.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items.length, pendingItems.length, conversationId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setScrollState({ conversationId, away: !stickToBottom.current });

    if (el.scrollTop < 40 && entry?.hasMore && entry.status === 'ready' && !olderFix.current) {
      olderFix.current = { height: el.scrollHeight };
      onOlder();
    }
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;

    stickToBottom.current = true;
    setScrollState({ conversationId, away: false });
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const ready = entry?.status === 'ready';
  const isEmpty = ready && items.length === 0 && pendingItems.length === 0;

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-scroll h-full overflow-y-auto px-3 py-2 sm:px-4"
      >
        {entry?.status === 'loading' && <Skeleton />}

        {entry?.status === 'error' && (
          <p className="py-3 text-center text-xs text-crewly-red">{entry.error}</p>
        )}

        {isEmpty && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-crewly-border bg-crewly-card text-crewly-dim">
              <MessageSquarePlus className="h-5 w-5" />
            </span>
            <p className="text-sm font-semibold text-crewly-text">No messages yet</p>
            <p className="max-w-[16rem] text-xs text-crewly-dim">
              {locked
                ? 'This conversation is disabled, so new messages are paused.'
                : 'Send the first message to start the conversation.'}
            </p>
          </div>
        )}

        {entry?.hasMore && (
          <p className="py-1 text-center text-[10px] text-crewly-dim">
            Scroll up for older messages
          </p>
        )}

        {items.map((message, index) => {
          const previous = items[index - 1];
          const newDay = index === 0 || dayKey(previous?.createdAt) !== dayKey(message.createdAt);

          return (
            <div key={message._id}>
              {newDay && (
                <div className="chat-day-sep my-3">
                  <span>{dayLabel(message.createdAt)}</span>
                </div>
              )}
              <MessageBubble
                message={message}
                mine={String(message.senderUserId) === String(meId)}
                senderName={nameOfUserId(message.senderUserId)}
                grouped={!newDay && shouldGroup(previous, message)}
                onEdit={onEdit}
                onDelete={onDelete}
                onReact={onReact}
                canModerate={canModerate}
                locked={locked}
              />
            </div>
          );
        })}

        {pendingItems.map((item) => (
          <div key={item.clientMessageId} className="mt-3 flex justify-end gap-2">
            <div className="max-w-[80%] rounded-xl border border-dashed border-crewly-green/40 bg-crewly-green/5 px-3 py-2 opacity-80">
              {(item.attachments ?? []).length > 0 && (
                <div className="mb-1.5 space-y-1">
                  {(item.attachments ?? []).map((attachment) => (
                    <p key={String(attachment.attachmentId)} className="truncate text-xs text-crewly-dim">
                      {attachment.fileName}
                    </p>
                  ))}
                </div>
              )}
              {item.text ? (
                <p className="whitespace-pre-wrap break-words text-sm text-crewly-text">{item.text}</p>
              ) : null}
              <p className="mt-1 text-right text-[10px] text-crewly-dim">sending…</p>
            </div>
          </div>
        ))}

        <div className="h-2" />
      </div>

      {awayFromBottom && !isEmpty && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
          className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-crewly-border bg-crewly-card px-3 py-1.5 text-[11px] font-semibold text-crewly-text shadow-lg transition hover:border-crewly-green hover:text-crewly-green"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Latest
        </button>
      )}
    </div>
  );
};

export default MessageList;
