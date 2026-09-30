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
//
// 36.6 — three more things, all read-only:
//
//   · STRUCTURED CARDS. A run of `- Label: value` bullets is re-rendered as
//     a small grid. The parser is deliberately conservative (see
//     replyCards.js): a misparse degrades to the plain text 36.3 shipped,
//     never to a card that dropped half an answer.
//
//   · DEEP-LINK CHIPS. Navigation ONLY. The assistant never performs an
//     action — it points at a screen and the person decides.
//
//   · FOLLOW-UP CHIPS. Clicking one submits it as the next question.
//     Every one of them came from the model's own reply or from the
//     server's static fallback list; nothing is invented here.
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

import { useNavigate } from 'react-router-dom';

import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Sparkles,
  User,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { parseReplyBlocks } from './replyCards.js';
import { useProgressiveReveal } from './useProgressiveReveal.js';


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
  followUpQuestions = [],
  deepLinks = [],
  onFollowUp,
}) => {
  const isAssistant = role === 'assistant';

  // 36.6 — navigation only. `navigate` is the existing router hook; there
  // is no API call behind a chip and no state change anywhere but the URL.
  const navigate = useNavigate();

  // Both arrays are normalized here as well as in the service, because this
  // component is also rendered by tests and by any future caller.
  const questions = Array.isArray(followUpQuestions) ? followUpQuestions : [];

  const links = Array.isArray(deepLinks) ? deepLinks : [];

  /*
   * 36.6 — PROGRESSIVE REVEAL.
   *
   * The reply types itself out. `done` gates the structured cards and the
   * chips, because a card built from a half-typed bullet list would flicker
   * in and out of existence as the reveal progressed, and a chip that
   * appears before the answer has finished is just a distraction.
   *
   * While the reveal is running the reply is rendered as ONE plain block,
   * exactly as 36.3 rendered it. No re-layout mid-animation, and nothing
   * the parser could misread is on screen yet.
   *
   * The user's own messages never animate: they were typed by hand and
   * appearing instantly is the correct behaviour for them.
   */
  const { shown, done } = useProgressiveReveal(content, {
    enabled: isAssistant,
  });

  // Parsed once per render, not per block.
  const blocks = parseReplyBlocks(shown);

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
        {/*
         * 36.6 — the reply is rendered block by block. A text block keeps
         * `whitespace-pre-wrap` exactly as 36.3 shipped it, so a multi-line
         * answer still reads as written. A card block re-renders the SAME
         * label and value as a small grid.
         *
         * Nothing is removed: every line the model wrote is on screen, just
         * laid out differently when the shape is unambiguous.
         */}
        {done ? (
          blocks.map((block, index) => {
            if (block.type === 'cards') {
            return (
              <div
                key={`cards-${index}`}
                className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2"
              >
                {block.items.map((item, itemIndex) => (
                  <div
                    key={`${item.label}-${itemIndex}`}
                    className="rounded-lg border border-crewly-border bg-crewly-bg/50 px-2 py-1.5"
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-crewly-dim">
                      {item.label}
                    </p>

                    <p className="mt-0.5 text-[12px] font-semibold text-crewly-text">
                      {item.value}
                    </p>
                  </div>
                ))}
              </div>
            );
          }

              return (
                <p
                  key={`text-${index}`}
                  className="whitespace-pre-wrap break-words"
                >
                  {block.text}
                </p>
              );
          })
        ) : (
          // Mid-reveal: one plain block, indented by nothing, exactly as
          // 36.3 rendered the whole reply.
          <p className="whitespace-pre-wrap break-words">{shown}</p>
        )}

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

        {/*
         * 36.6 — the two chip rows, assistant replies only.
         *
         * NAVIGATION, NEVER ACTION. A deep link changes the URL and nothing
         * else. The assistant has no ability to apply for leave, approve
         * anything or change a record, and a chip must not imply it does.
         */}
        {isAssistant && done && links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {links.map((link) => (
              <button
                key={link.path}
                type="button"
                onClick={() => navigate(link.path)}
                title={`Open ${link.label}`}
                className="flex items-center gap-1 rounded-full border border-crewly-green/40 bg-crewly-green/10 px-2.5 py-1 text-[11px] font-semibold text-crewly-green transition hover:bg-crewly-green/20 active:scale-[0.98]"
              >
                <ExternalLink
                  className="h-3 w-3 shrink-0"
                  aria-hidden="true"
                  strokeWidth={2}
                />
                {link.label}
              </button>
            ))}
          </div>
        )}

        {/*
         * Follow-up suggestions. Clicking one sends it as the next question,
         * which is the whole point: a person who does not know what to ask
         * next gets a one-tap way to find out.
         *
         * These come from the model's own reply or from the server's static
         * fallback list. Nothing here is generated in the browser.
         */}
        {isAssistant && done && questions.length > 0 && onFollowUp && (
          <div className="mt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-crewly-dim">
              You might also ask
            </p>

            <div className="mt-1 flex flex-wrap gap-1.5">
              {questions.map((question) => (
                <button
                  key={question}
                  type="button"
                  onClick={() => onFollowUp(question)}
                  className="flex items-center gap-1 rounded-full border border-crewly-border bg-crewly-card px-2.5 py-1 text-[11px] text-crewly-text transition hover:border-crewly-green/50 hover:text-crewly-green active:scale-[0.98]"
                >
                  <Sparkles
                    className="h-3 w-3 shrink-0"
                    aria-hidden="true"
                    strokeWidth={1.8}
                  />
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}
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
