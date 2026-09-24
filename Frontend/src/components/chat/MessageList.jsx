// PHASE 33.8 — scrollable history. Loads older pages on scroll-up without
// losing position; sticks to the bottom for new arrivals only when the
// reader is already near the bottom.
import { useLayoutEffect, useRef } from 'react';

import MessageBubble from './MessageBubble.jsx';

const MessageList = ({
  conversationId,
  entry,
  pending,
  meId,
  nameOfUserId,
  onOlder,
  onEdit,
  onDelete,
  canModerate = false,
  locked = false,
}) => {
  const scrollRef = useRef(null);
  const stickToBottom = useRef(true);
  const olderFix = useRef(null);

  const items = entry?.items ?? [];
  const pendingItems = pending ?? [];

  // New conversation open: land at the newest message.
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

    if (el.scrollTop < 40 && entry?.hasMore && entry.status === 'ready' && !olderFix.current) {
      olderFix.current = { height: el.scrollHeight };
      onOlder();
    }
  };

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 space-y-2 overflow-y-auto p-4">
      {entry?.status === 'loading' && <p className="text-center text-xs text-crewly-dim">Loading history...</p>}
      {entry?.status === 'error' && <p className="text-center text-xs text-crewly-red">{entry.error}</p>}
      {entry?.status === 'ready' && items.length === 0 && pendingItems.length === 0 && (
        <p className="text-center text-xs text-crewly-dim">No messages yet. Say hello.</p>
      )}
      {entry?.hasMore && <p className="text-center text-[10px] text-crewly-dim">Scroll up for older messages</p>}

      {items.map((message) => (
        <MessageBubble
          key={message._id}
          message={message}
          mine={String(message.senderUserId) === String(meId)}
          senderName={nameOfUserId(message.senderUserId)}
          onEdit={onEdit}
          onDelete={onDelete}
          canModerate={canModerate}
          locked={locked}
        />
      ))}

      {pendingItems.map((item) => (
        <div key={item.clientMessageId} className="flex justify-end opacity-60">
          <div className="max-w-[78%] rounded-xl border border-crewly-green/40 bg-crewly-green/10 px-3 py-2">
            <p className="whitespace-pre-wrap break-words text-sm text-crewly-text">{item.text}</p>
            <p className="mt-1 text-[10px] text-crewly-dim">sending...</p>
          </div>
        </div>
      ))}
    </div>
  );
};

export default MessageList;
