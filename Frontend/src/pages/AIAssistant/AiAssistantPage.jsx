// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — AI ASSISTANT PAGE
//
// SESSION-ONLY CONVERSATION. There is no server-side chat history and nothing
// is written to localStorage: the messages array lives in React state for the
// life of this tab and is gone when the tab closes. A conversation about leave
// balances has no business outliving the session.
//
// WHAT THE CLIENT SENDS: { messages, categories? } and nothing else. No
// companyId, no userId, no user, no feature — the server derives every one of
// them from the caller's own session and refuses them from a body. The client
// has no tenant id to send, which is the point.
//
// WHAT THE CLIENT RECEIVES: { reply, usage, categoriesUsed }. Never the HR
// context and never the system prompt — those stay on the server.
//
// NO STREAMING, NO AGENT BEHAVIOUR: one turn is one request, and the reply
// arrives whole.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';

import { AlertTriangle, Bot, Info, Trash2 } from 'lucide-react';

import { useDispatch, useSelector } from 'react-redux';

import {
  conversationCleared,
  messageAdded,
  sendChatMessage,
} from '../../redux/slices/aiChatSlice.js';

import ChatInputBar from './ChatInputBar.jsx';
import ChatMessageBubble, { ChatTypingBubble } from './ChatMessageBubble.jsx';
import QuickPromptPills from './QuickPromptPills.jsx';
import { MAX_MESSAGES } from './chatLimits.js';

const WELCOME = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Hi, I am your Crewly HR assistant. I can answer questions about your own leave balance, attendance, shift timings, holidays, profile and company policies. Ask me anything below.",
};

/**
 * An honest, human-readable sentence for each server code the assistant can
 * return. The server's own message is already safe to show, so this only adds
 * the one thing it cannot know: what to do next.
 */
const ERROR_HINTS = Object.freeze({
  AI_RATE_LIMITED: 'You are asking faster than the assistant allows. Wait a few seconds and try again.',
  QUOTA_EXCEEDED: 'The monthly AI budget for your organization is used up. Ask your HR admin to review the quota.',
  AI_UNAVAILABLE: 'The assistant is switched off for your organization. Your HR admin can enable it under AI settings.',
  AI_CONFIG_READ_FAILED: 'The assistant could not read its settings. Try again shortly.',
  AI_VENDOR_ERROR: 'The AI provider did not answer. Try again shortly.',
  AI_REQUEST_INVALID: 'That question could not be sent as written.',
  AI_CONFIG_INVALID: 'The assistant is not configured correctly. Ask your HR admin to check the AI settings.',
});

const AiAssistantPage = () => {
  const dispatch = useDispatch();

  /*
   * 36.3-fix — THE BLANK-PAGE GUARD.
   *
   * 36.3 first shipped with the aiChat slice NOT registered in redux/store.js,
   * so state.aiChat was undefined and this destructuring threw during the very
   * first render: the route rendered a completely black page with no sidebar
   * and no error. Registering the slice is the fix; the defaults below are the
   * safety net, so that any future slice slip degrades to an empty chat rather
   * than to a blank screen.
   */
  const {
    messages = [],
    sending = false,
    error = '',
    errorCode = '',
    categoriesUsed = [],
    usage = null,
  } = useSelector((state) => state.aiChat) ?? {};

  const [draft, setDraft] = useState('');

  const endRef = useRef(null);

  // Keep the newest turn in view without hijacking the scroll position when
  // the person has scrolled up to re-read something.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, sending]);

  const send = useCallback(
    async (text) => {
      const content = String(text || '').trim();

      if (!content || sending) return;

      // The display cap mirrors the UI contract; the server caps the history
      // itself, so dropping the oldest turn here is cosmetic, not protective.
      const next = [...messages, { id: `user-${Date.now()}`, role: 'user', content }];
      const trimmed = next.slice(-MAX_MESSAGES);

      dispatch(messageAdded({ id: next[next.length - 1].id, role: 'user', content }));

      await dispatch(
        sendChatMessage({
          messages: trimmed.map(({ role: roleName, content: body }) => ({
            role: roleName,
            content: body,
          })),
        }),
      );

      setDraft('');
    },
    [dispatch, messages, sending],
  );

  const shown = messages.length > 0 ? messages : [WELCOME];

  return (
    <div className="flex h-[calc(100vh-140px)] min-h-[480px] flex-col overflow-hidden rounded-xl border border-crewly-border bg-crewly-bg">
      <header className="flex items-center gap-3 border-b border-crewly-border px-3 py-2.5 sm:px-4">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-crewly-green"
        >
          <Bot className="h-4 w-4" strokeWidth={1.8} />
        </span>

        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-bold text-crewly-text">HR Assistant</h1>

          <p className="truncate text-[11px] text-crewly-dim">
            Answers only from your own HR data. It cannot approve, apply or change anything.
          </p>
        </div>

        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              dispatch(conversationCleared());
              setDraft('');
            }}
            className="flex shrink-0 items-center gap-1.5 rounded border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-dim transition hover:text-crewly-text"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={1.8} />
            Clear
          </button>
        )}
      </header>

      {/* What actually answered. Shown only after the first successful turn, so
          the header is not cluttered before there is anything to report. */}
      {categoriesUsed.length > 0 && (
        <p className="flex items-center gap-1.5 border-b border-crewly-border px-3 py-1.5 text-[10px] text-crewly-dim sm:px-4">
          <Info className="h-3 w-3 shrink-0" aria-hidden="true" strokeWidth={1.8} />
          <span className="truncate">
            Answered using: {categoriesUsed.join(', ')}
            {usage?.totalTokens ? ` — ${usage.totalTokens} tokens this turn` : ''}
          </span>
        </p>
      )}

      {/* Errors are rendered OUTSIDE the message list, so a failed turn can
          never be mistaken for the assistant's answer. */}
      {error && (
        <div className="flex items-start gap-2 border-b border-crewly-red/40 bg-crewly-red/10 px-3 py-2 text-xs text-crewly-red sm:px-4">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" strokeWidth={1.8} />
          <div className="min-w-0">
            <p className="font-semibold">{error}</p>
            <p className="mt-0.5 text-crewly-red/80">
              {ERROR_HINTS[errorCode] || 'Try again, or contact your HR team if this keeps happening.'}
            </p>
          </div>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
        {shown.map((message) => (
          <ChatMessageBubble
            key={message.id}
            role={message.role}
            content={message.content}
          />
        ))}

        {sending && <ChatTypingBubble />}

        <div ref={endRef} />
      </div>

      <div className="space-y-3 border-t border-crewly-border px-3 py-3 sm:px-4">
        {/* Pills are an introduction: they step aside once the conversation
            has started, rather than sitting on top of the replies forever. */}
        {messages.length === 0 && (
          <QuickPromptPills onSelect={send} disabled={sending} />
        )}

        <ChatInputBar
          onSend={send}
          sending={sending}
          value={draft}
          onChange={setDraft}
        />
      </div>
    </div>
  );
};

export default AiAssistantPage;
