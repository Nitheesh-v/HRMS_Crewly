// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — CHAT INPUT BAR
//
// A plain textarea, not a rich editor: there is nothing here that needs markup.
//
// The character counter mirrors the SERVER's limit (2000) so the person finds
// out before submitting rather than from an error. The form refuses to submit
// on whitespace only, which is the same rule the server applies.
//
// Enter sends. Shift+Enter makes a new line — the conventional arrangement,
// and the hint is printed under the field so nobody has to guess.
// ═══════════════════════════════════════════════════════════════════════════

import { useId } from 'react';

import { Send } from 'lucide-react';

import { MAX_MESSAGE_CHARS } from './chatLimits.js';

/**
 * Controlled by the page: the page clears the field once a turn is dispatched,
 * so the draft cannot survive a send and be submitted twice.
 */
const ChatInputBar = ({ value = '', onChange, onSend, sending = false }) => {
  const inputId = useId();

  const trimmed = String(value).trim();

  const canSend = trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_CHARS;

  const submit = () => {
    if (!canSend) return;

    onSend(trimmed);
  };

  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;

    // Enter sends; Shift+Enter is a newline.
    event.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Ask the HR assistant a question
      </label>

      <div className="flex items-end gap-2">
        <textarea
          id={inputId}
          rows={2}
          value={value}
          disabled={sending}
          maxLength={MAX_MESSAGE_CHARS}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your leave, attendance, shifts or holidays..."
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-crewly-border bg-crewly-card px-3 py-2 text-[13px] text-crewly-text placeholder-crewly-dim outline-none transition focus:border-crewly-green focus:ring-2 focus:ring-crewly-green/20 disabled:opacity-60"
        />

        <button
          type="submit"
          disabled={!canSend || sending}
          className="flex h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-crewly-green px-3.5 text-[13px] font-semibold text-crewly-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
          <span className="hidden sm:inline">{sending ? 'Sending' : 'Send'}</span>
        </button>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-crewly-dim">
        <span>Enter to send, Shift + Enter for a new line</span>
        <span className={value.length > MAX_MESSAGE_CHARS * 0.9 ? 'text-crewly-orange' : ''}>
          {value.length} / {MAX_MESSAGE_CHARS}
        </span>
      </div>
    </form>
  );
};

export default ChatInputBar;
