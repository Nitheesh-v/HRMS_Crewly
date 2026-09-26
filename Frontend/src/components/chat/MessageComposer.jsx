// PHASE 33.8 — composer. The client generates the idempotency key
// (clientMessageId); the server allocates seq. No typing indicators.
//
// UI pass: the box grows with the text instead of staying one line, the
// counter appears only near the cap, the disabled state says WHY, and the
// send button is reachable by keyboard with a label screen readers can use.
import { useEffect, useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';

import AttachmentPicker from './AttachmentPicker.jsx';
import { hasVisibleText } from '../../utils/chatText.js';

const TEXT_MAX = 4000;
const COUNTER_FROM = 3600;
const MAX_HEIGHT_PX = 160;

// PHASE 33.10 — attachments. Files upload on SELECT (REST); the send goes out
// as one FILE message over the socket, so the idempotency key and seq
// allocation are the same ones text uses. A message carries exactly ONE type,
// so text + files is still a FILE message — the files are the part that needs
// a server id, and the text simply rides along as the message body.
const MessageComposer = ({
  disabled,
  disabledReason = '',
  onSend,
  conversationId,
  pendingAttachments = [],
  onAddAttachment,
  onRemoveAttachment,
  // 34.2 — "Replying to …" shown above the box. The page owns the state; the
  // composer only reserves the space for it.
  replyPill = null,
}) => {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const textareaRef = useRef(null);

  const trimmed = text.trim();
  const hasFiles = pendingAttachments.length > 0;
  // 33.10-fix2 — a body of zero-width characters is not a message: the send
  // stays disabled, exactly as it would be for an empty box. (The server
  // refuses it too; this is the fast gate, not the authority.)
  const canSend = hasVisibleText(trimmed) || hasFiles;

  // Grow with the content, then scroll inside the box. Height is reset first so
  // deleting text shrinks the box again (scrollHeight never reports smaller).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const submit = async () => {
    if (!canSend || disabled) return;

    setError('');
    const failure = hasFiles
      ? await onSend(trimmed, pendingAttachments)
      : await onSend(trimmed, []);

    if (failure) {
      setError(failure);
      return;
    }

    setText('');
  };

  return (
    <div className="border-t border-crewly-border bg-crewly-bg p-2.5 sm:p-3">
      {error && (
        <p role="alert" className="mb-2 flex items-center gap-1.5 text-xs text-crewly-red">
          {error}
        </p>
      )}

      {replyPill}

      {disabled && disabledReason && !error && (
        <p className="mb-2 text-[11px] text-crewly-dim">{disabledReason}</p>
      )}

      <div className="flex items-end gap-2">
        <AttachmentPicker
          conversationId={conversationId}
          pending={pendingAttachments}
          onAdd={onAddAttachment}
          onRemove={onRemoveAttachment}
          disabled={disabled}
        />

        <div className="min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            className="input chat-scroll max-h-40 min-h-[42px] resize-none py-2.5 leading-relaxed"
            rows={1}
            maxLength={TEXT_MAX}
            placeholder={disabled ? 'Sending is paused' : 'Write a message'}
            value={text}
            disabled={disabled}
            aria-label="Message"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />

          <div className="mt-1 flex items-center justify-between px-1">
            <p className="hidden text-[10px] text-crewly-dim sm:block">
              Enter to send · Shift + Enter for a new line
            </p>
            {text.length >= COUNTER_FROM && (
              <p className={`text-[10px] tabular-nums ${text.length >= TEXT_MAX ? 'text-crewly-red' : 'text-crewly-dim'}`}>
                {text.length}/{TEXT_MAX}
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn-primary mb-5 px-3.5 py-2.5"
          disabled={disabled || !canSend}
          onClick={submit}
          aria-label="Send message"
          title="Send message"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default MessageComposer;
