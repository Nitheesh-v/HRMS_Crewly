// PHASE 33.8 — composer. The client generates the idempotency key
// (clientMessageId); the server allocates seq. No typing indicators.
//
// UI pass: the box grows with the text instead of staying one line, the
// counter appears only near the cap, the disabled state says WHY, and the
// send button is reachable by keyboard with a label screen readers can use.
import { useEffect, useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';

import AttachmentPicker from './AttachmentPicker.jsx';
import MentionAutocomplete from './MentionAutocomplete.jsx';
import { hasVisibleText } from '../../utils/chatText.js';
// 34.3 — the caret scan, the insert and the reconcile are pure helpers: the
// component owns only the open/closed state and the keyboard.
import {
  CHAT_MENTION_MAX_PER_MESSAGE,
  insertMention,
  mentionQueryAt,
  mentionSuggestions,
  visibleMentionIds,
} from '../../utils/chatMentions.js';

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
  // 34.3 — who may be mentioned: the members of THIS conversation, already
  // projected by the backend read path (no directory lookup, no new endpoint).
  mentionMembers = [],
  meId = null,
  // 34.5 — the composer reports "there is text in the box" and nothing else.
  // The page owns the timers, the socket and the conversation boundary, so the
  // box stays a box (and a keystroke can never reach the network from here).
  onTypingChange = null,
}) => {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  // The mentions PICKED in this draft ({ userId, token }). They are reconciled
  // against the text at send time, so deleting the token simply stops the
  // mention from going out — no fragile bookkeeping on every keystroke.
  const [mentions, setMentions] = useState([]);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const caretAfterInsert = useRef(null);
  const textareaRef = useRef(null);

  const query = mentionQueryAt(text, caret);

  const atLimit = mentions.length >= CHAT_MENTION_MAX_PER_MESSAGE;

  const full = Boolean(query) && atLimit;

  const suggestions = full ? [] : mentionSuggestions({ members: mentionMembers, query: query?.query ?? '', meId });

  const open = Boolean(query) && !dismissed;

  // Place the caret after an inserted token once React has re-rendered the
  // textarea (DOM work only — no state is set from an effect).
  useEffect(() => {
    if (caretAfterInsert.current === null) return;

    const el = textareaRef.current;
    const position = caretAfterInsert.current;

    caretAfterInsert.current = null;

    if (!el) return;

    el.focus();
    el.setSelectionRange(position, position);
    setCaret(position);
  }, [text]);

  const pick = (suggestion) => {
    if (!query) return;

    const { text: nextText, caret: nextCaret } = insertMention({
      text,
      start: query.start,
      end: query.end,
      token: `@${suggestion.name}`,
    });

    caretAfterInsert.current = nextCaret;

    setText(nextText);
    setMentions((current) =>
      current.some((entry) => entry.userId === suggestion.userId)
        ? current
        : [...current, { userId: suggestion.userId, token: `@${suggestion.name}` }]
    );
    setDismissed(false);
    setActiveIndex(0);
    setError('');
  };

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

    // 34.3 — only the mentions still visible in the text are sent; the server
    // verifies them again (membership, tenant, visibility) and drops what it
    // cannot see, so a stale pick can never become an invisible ping.
    const mentionIds = visibleMentionIds(mentions, trimmed);

    const failure = hasFiles
      ? await onSend(trimmed, pendingAttachments, mentionIds)
      : await onSend(trimmed, [], mentionIds);

    if (failure) {
      setError(failure);
      return;
    }

    setText('');
    setMentions([]);
    setCaret(0);
    // 34.5 — sending ends the indicator at once: the message itself is the
    // signal now, and a lingering "…is typing" beside a delivered message
    // reads as a lie.
    onTypingChange?.(false);
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

        <div className="relative min-w-0 flex-1">
          {open && (
            <MentionAutocomplete
              suggestions={suggestions}
              activeIndex={activeIndex}
              full={full}
              onSelect={pick}
              onHover={setActiveIndex}
            />
          )}

          <textarea
            ref={textareaRef}
            className="input chat-scroll max-h-40 min-h-[42px] resize-none py-2.5 leading-relaxed"
            rows={1}
            maxLength={TEXT_MAX}
            placeholder={disabled ? 'Sending is paused' : 'Write a message'}
            value={text}
            disabled={disabled}
            aria-label="Message"
            aria-autocomplete="list"
            onBlur={() => setDismissed(true)}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              // 34.5 — one boolean per keystroke; the page debounces it.
              onTypingChange?.(hasVisibleText(event.target.value));
              setDismissed(false);
              setActiveIndex(0);
            }}
            onClick={(event) => setCaret(event.target.selectionStart ?? 0)}
            onKeyUp={(event) => {
              // Arrow keys move the caret without changing the text; the query
              // must follow the caret, or the list would filter from a stale
              // position.
              if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                setCaret(event.target.selectionStart ?? 0);
              }
            }}
            onKeyDown={(event) => {
              // While the suggestion list is open it owns the keyboard, so
              // Enter PICKS instead of sending — the one thing that would be
              // maddening if it went the other way.
              if (open) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((index) => (suggestions.length ? (index + 1) % suggestions.length : 0));
                  return;
                }

                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((index) =>
                    suggestions.length ? (index - 1 + suggestions.length) % suggestions.length : 0
                  );
                  return;
                }

                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDismissed(true);
                  return;
                }

                if ((event.key === 'Enter' || event.key === 'Tab') && suggestions[activeIndex]) {
                  event.preventDefault();
                  pick(suggestions[activeIndex]);
                  return;
                }
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />

          <div className="mt-1 flex items-center justify-between px-1">
            <p className="hidden text-[10px] text-crewly-dim sm:block">
              Enter to send · Shift + Enter for a new line
              {mentionMembers.length > 0 ? ' · @ to mention someone in this conversation' : ''}
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
