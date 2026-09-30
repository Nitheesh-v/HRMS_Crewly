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
//
// 36.5 — THE MICROPHONE. Browser-native Web Speech only: no package, no
// vendor, no upload of ours. The button is rendered ONLY when the browser
// can actually do it, because a button that does nothing is worse than a
// missing one. Firefox (flag off) and most embedded webviews never see it.
// ═══════════════════════════════════════════════════════════════════════════

import { useId } from 'react';

import { Mic, MicOff, Send } from 'lucide-react';

import { MAX_MESSAGE_CHARS } from './chatLimits.js';

/**
 * Controlled by the page: the page clears the field once a turn is dispatched,
 * so the draft cannot survive a send and be submitted twice.
 */
/**
 * @param {object}   props
 * @param {string}   props.value
 * @param {Function} props.onChange
 * @param {Function} props.onSend   (text, meta) — meta.sentViaVoice is
 *        true when the text came out of the microphone, which is how the
 *        panel decides whether to read the reply aloud.
 * @param {boolean}  props.sending
 * @param {object}   [props.voice]   The recogniser, owned by the panel.
 *        `supported: false` means no mic button at all.
 */
const ChatInputBar = ({
  value = '',
  onChange,
  onSend,
  sending = false,
  voice = null,
}) => {
  const inputId = useId();

  const trimmed = String(value).trim();

  const canSend = trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_CHARS;

  // 36.5 — true only when the browser exposed a WORKING recogniser.
  const voiceSupported = voice?.supported === true;
  const listening = voice?.listening === true;

  const submit = () => {
    if (!canSend) return;

    onSend(trimmed, { sentViaVoice: listening });
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

        {/* 36.5 — the microphone. Rendered only when the browser can
            actually recognise speech; a disabled stub would be a lie. */}
        {voiceSupported && (
          <button
            type="button"
            onClick={voice.toggle}
            disabled={sending}
            title={listening ? 'Stop listening' : 'Speak your question'}
            aria-label={listening ? 'Stop listening' : 'Speak your question'}
            aria-pressed={listening}
            className={`flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-lg border transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${
              listening
                ? 'border-crewly-red/50 bg-crewly-red/15 text-crewly-red'
                : 'border-crewly-border bg-crewly-card text-crewly-dim hover:text-crewly-text'
            }`}
          >
            {listening ? (
              <MicOff className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
            ) : (
              <Mic className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
            )}
          </button>
        )}

        <button
          type="submit"
          disabled={!canSend || sending}
          className="flex h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-crewly-green px-3.5 text-[13px] font-semibold text-crewly-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
          <span className="hidden sm:inline">{sending ? 'Sending' : 'Send'}</span>
        </button>
      </div>

      {/* 36.5 — what the recogniser has heard so far. Shown INSTEAD of the
          Enter hint while listening, so the person is never told two
          contradictory things at once. */}
      {listening ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-crewly-red">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-crewly-red" />
          <span className="truncate">
            {voice?.interim ? voice.interim : 'Listening… speak now'}
          </span>
        </p>
      ) : (
        <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-crewly-dim">
          <span>Enter to send, Shift + Enter for a new line</span>
          <span className={value.length > MAX_MESSAGE_CHARS * 0.9 ? 'text-crewly-orange' : ''}>
            {value.length} / {MAX_MESSAGE_CHARS}
          </span>
        </div>
      )}
    </form>
  );
};

export default ChatInputBar;
