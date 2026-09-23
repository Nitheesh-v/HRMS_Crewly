// PHASE 33.8 — composer. The client generates the idempotency key
// (clientMessageId); the server allocates seq. No typing indicators.
import { useState } from 'react';
import { Send } from 'lucide-react';

const TEXT_MAX = 4000;

const MessageComposer = ({ disabled, onSend }) => {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const trimmed = text.trim();

  const submit = async () => {
    if (!trimmed || disabled) return;

    setError('');
    const failure = await onSend(trimmed);

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
          disabled={disabled || !trimmed}
          onClick={submit}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default MessageComposer;
