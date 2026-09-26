// PHASE 33.8 — composer. The client generates the idempotency key
// (clientMessageId); the server allocates seq. No typing indicators.
import { useState } from 'react';
import { Send } from 'lucide-react';

import AttachmentPicker from './AttachmentPicker.jsx';

const TEXT_MAX = 4000;

// PHASE 33.10 — attachments. Files upload on SELECT (REST); the send goes out
// as one FILE message over the socket, so the idempotency key and seq
// allocation are the same ones text uses. A message carries exactly ONE type,
// so text + files is still a FILE message — the files are the part that needs
// a server id, and the text simply rides along as the message body.
const MessageComposer = ({
  disabled,
  onSend,
  conversationId,
  pendingAttachments = [],
  onAddAttachment,
  onRemoveAttachment,
}) => {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const trimmed = text.trim();
  const hasFiles = pendingAttachments.length > 0;
  const canSend = Boolean(trimmed) || hasFiles;

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
    <div className="border-t border-crewly-border p-3">
      {error && <p className="mb-2 text-xs text-crewly-red">{error}</p>}
      <div className="flex items-end gap-2">
        <AttachmentPicker
          conversationId={conversationId}
          pending={pendingAttachments}
          onAdd={onAddAttachment}
          onRemove={onRemoveAttachment}
          disabled={disabled}
        />
        <textarea
          className="input min-h-[42px] flex-1 resize-none"
          rows={1}
          maxLength={TEXT_MAX}
          placeholder="Write a message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="btn-primary px-4 py-2.5"
          disabled={disabled || !canSend}
          onClick={submit}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default MessageComposer;
