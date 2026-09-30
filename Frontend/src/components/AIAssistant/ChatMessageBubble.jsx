// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — ONE CHAT MESSAGE BUBBLE
//
// Rendered as PLAIN TEXT (React text nodes), never as HTML: the reply is model
// output and the user's own words are their own words, but neither is a reason
// to run an HTML parser on them.
//
// No emojis anywhere in this UI — the icon set is lucide-react only.
//
// 36.4 — an optional COPY affordance. The reply is the only thing this UI ever
// shows, and people paste it into tickets and emails, so the panel offers it
// rather than making them select the text by hand.
//
// 36.5 — an optional SPEAK affordance, and only on the assistant's own
// replies. Reading a person their own question back to them is noise.
// Browser-native speechSynthesis: no vendor, no audio file, nothing stored.
//
// The button is offered only when the browser can synthesise at all, and it
// toggles: a second press stops a reply that is already being read. The
// `speaking` prop is the panel's answer to "is THIS bubble the one being
// read", so two bubbles never both claim to be speaking.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { Bot, Check, Copy, User, Volume2, VolumeX } from 'lucide-react';


/**
 * @param {object}   props
 * @param {string}   props.role
 * @param {string}   props.content
 * @param {Function} [props.onCopy]
 * @param {Function} [props.onSpeak]  Provided only on assistant replies,
 *        and only when the browser can synthesise. Absent means no button.
 * @param {boolean}  [props.speaking] True when THIS bubble is being read.
 */
const ChatMessageBubble = ({
  role = 'user',
  content = '',
  onCopy,
  onSpeak,
  speaking = false,
}) => {
  const isAssistant = role === 'assistant';

  // Local, transient, and never persisted: it exists only to swap the icon for
  // a moment so the person knows the click landed.
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = String(content || '');

    if (!text) return;

    try {
      // The clipboard API is unavailable in insecure contexts and in some
      // embedded frames. A missing button is a better failure than a thrown
      // promise the user cannot act on, so this degrades silently.
      await navigator.clipboard.writeText(text);

      setCopied(true);

      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* nothing to do — the text is still selectable by hand */
    }
  };

  return (
    <div
      className={`flex w-full gap-2.5 ${
        isAssistant ? 'justify-start' : 'justify-end'
      }`}
    >
      {isAssistant && (
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-crewly-green"
        >
          <Bot className="h-4 w-4" strokeWidth={1.8} />
        </span>
      )}

      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed sm:max-w-[75%] ${
          isAssistant
            ? 'bg-crewly-card text-crewly-text'
            : 'bg-crewly-green/15 text-crewly-text'
        }`}
      >
        {/* Whitespace is preserved so a multi-line answer reads as written. */}
        <p className="whitespace-pre-wrap break-words">{content}</p>

        {/* The two affordances share one row. They are small on purpose:
            the reply is the content, these are conveniences. */}
        <div className="mt-1.5 flex items-center gap-2">
          {onCopy && (
            <button
              type="button"
              onClick={copy}
              title={copied ? 'Copied' : 'Copy this answer'}
              aria-label={copied ? 'Answer copied' : 'Copy this answer'}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-semibold text-crewly-dim transition hover:text-crewly-text"
            >
              {copied ? (
                <Check className="h-3 w-3" aria-hidden="true" strokeWidth={2} />
              ) : (
                <Copy className="h-3 w-3" aria-hidden="true" strokeWidth={1.8} />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}

          {/* 36.5 — read this answer aloud. Only ever on an assistant
              reply, and only when the browser can speak. */}
          {isAssistant && onSpeak && (
            <button
              type="button"
              onClick={onSpeak}
              title={speaking ? 'Stop reading' : 'Read this answer aloud'}
              aria-label={
                speaking ? 'Stop reading this answer' : 'Read this answer aloud'
              }
              aria-pressed={speaking}
              className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-semibold transition ${
                speaking
                  ? 'text-crewly-green'
                  : 'text-crewly-dim hover:text-crewly-text'
              }`}
            >
              {speaking ? (
                <VolumeX className="h-3 w-3" aria-hidden="true" strokeWidth={2} />
              ) : (
                <Volume2 className="h-3 w-3" aria-hidden="true" strokeWidth={1.8} />
              )}
              {speaking ? 'Stop' : 'Listen'}
            </button>
          )}
        </div>
      </div>

      {!isAssistant && (
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-crewly-border/40 text-crewly-dim"
        >
          <User className="h-4 w-4" strokeWidth={1.8} />
        </span>
      )}
    </div>
  );
};

/** The typing indicator shown while the assistant is working. */
export const ChatTypingBubble = () => (
  <div className="flex w-full justify-start gap-2.5">
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-crewly-green"
    >
      <Bot className="h-4 w-4" strokeWidth={1.8} />
    </span>

    <div className="rounded-xl bg-crewly-card px-3 py-2.5">
      <span className="sr-only">The assistant is typing</span>
      <span className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-crewly-dim" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-crewly-dim [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-crewly-dim [animation-delay:300ms]" />
      </span>
    </div>
  </div>
);

export default ChatMessageBubble;
