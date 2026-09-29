// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — ONE CHAT MESSAGE BUBBLE
//
// Rendered as PLAIN TEXT (React text nodes), never as HTML: the reply is model
// output and the user's own words are their own words, but neither is a reason
// to run an HTML parser on them.
//
// No emojis anywhere in this UI — the icon set is lucide-react only.
// ═══════════════════════════════════════════════════════════════════════════

import { Bot, User } from 'lucide-react';


const ChatMessageBubble = ({ role = 'user', content = '' }) => {
  const isAssistant = role === 'assistant';

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
