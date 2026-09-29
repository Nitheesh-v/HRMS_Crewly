// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — AI ASSISTANT PANEL (the chat body)
//
// Lives inside the floating widget, not on its own route. See
// AiAssistantWidget.jsx for the shell.
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
//
// 36.4 — RETRY AND COPY. A transient vendor failure used to leave the person
// retyping the question. The retry button re-sends the conversation exactly as
// it stands; the server is stateless and rebuilds the context itself, so
// retrying is safe and needs no extra state. Copy is offered on the answer,
// because the reply is the only thing this UI ever produces.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';

import { AlertTriangle, Bot, Info, RotateCcw, Trash2, X } from 'lucide-react';

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
    'Hi, I am your Crewly HR assistant. I can answer questions about your own leave balance and history, attendance, shift timings, holidays, profile, tasks, projects, expenses, payslips and documents. I can also tell you how to apply for leave, punch in, or claim an expense. Ask me anything below.',
};

/**
 * An honest, human-readable sentence for each server code the assistant can
 * return. The server's own message is already safe to show, so this only adds
 * the one thing it cannot know: what to do next.
 */
const ERROR_HINTS = Object.freeze({
  AI_RATE_LIMITED:
    'You are asking faster than the assistant allows. Wait a few seconds and try again.',
  QUOTA_EXCEEDED:
    'The monthly AI budget for your organization is used up. Ask your HR admin to review the quota.',
  AI_UNAVAILABLE:
    'The assistant is switched off for your organization. Your HR admin can enable it under AI settings.',
  AI_CONFIG_READ_FAILED: 'The assistant could not read its settings. Try again shortly.',
  AI_VENDOR_ERROR: 'The AI provider did not answer. Try again shortly.',
  AI_REQUEST_INVALID: 'That question could not be sent as written.',
  AI_CONFIG_INVALID:
    'The assistant is not configured correctly. Ask your HR admin to check the AI settings.',
});

const AiAssistantPanel = ({ onClose }) => {
  const dispatch = useDispatch();

  /*
   * 36.3-fix — THE BLANK-PAGE GUARD.
   *
   * 36.3 first shipped with the aiChat slice NOT registered in redux/store.js,
   * so state.aiChat was undefined and this destructuring threw during the very
   * first render. Registering the slice is the fix; the defaults below are the
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

  // Keep the newest turn in view. Guarded on `open` so the panel does not
  // scroll itself while it is closed and invisible.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, sending]);

  const send = useCallback(
    async (text) => {
      const content = String(text || '').trim();

      if (!content || sending) return;

      // The display cap mirrors the UI contract; the server caps the history
      // itself, so dropping the oldest turn here is cosmetic, not protective.
      const next = [
        ...messages,
        { id: `user-${Date.now()}`, role: 'user', content },
      ];

      const trimmed = next.slice(-MAX_MESSAGES);

      dispatch(
        messageAdded({ id: next[next.length - 1].id, role: 'user', content }),
      );

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

  /**
   * Re-send the conversation as it stands.
   *
   * No new state and no queue: the server is stateless, rebuilds the HR
   * context from scratch on every call and caps the history itself, so the
   * exact same payload that just failed is the exact payload to send again.
   * Deliberately does NOT append a duplicate user turn — the question is
   * already on screen, and repeating it would read as the person having asked
   * twice.
   */
  const retry = useCallback(async () => {
    if (sending || messages.length === 0) return;

    await dispatch(
      sendChatMessage({
        messages: messages
          .slice(-MAX_MESSAGES)
          .map(({ role: roleName, content: body }) => ({
            role: roleName,
            content: body,
          })),
      }),
    );
  }, [dispatch, messages, sending]);

  const shown = messages.length > 0 ? messages : [WELCOME];

  // Copy is offered on the newest answer only. A button on every bubble turns
  // the transcript into a wall of controls.
  const lastAssistantId = [...shown]
    .reverse()
    .find((message) => message.role === 'assistant')?.id;

  return (
    <>
      <header className="flex items-center gap-3 border-b border-crewly-border px-3 py-2.5 sm:px-4">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-crewly-green"
        >
          <Bot className="h-4 w-4" strokeWidth={1.8} />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-crewly-text">HR Assistant</h2>

          <p className="truncate text-[11px] text-crewly-dim">
            Answers only from your own HR data. It cannot approve, apply or
            change anything.
          </p>
        </div>

        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              dispatch(conversationCleared());
              setDraft('');
            }}
            title="Start a new conversation"
            className="flex shrink-0 items-center gap-1.5 rounded border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-dim transition hover:text-crewly-text"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={1.8} />
            Clear
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close the HR assistant"
          className="shrink-0 rounded p-1.5 text-crewly-dim transition hover:bg-crewly-card hover:text-crewly-text"
        >
          <X className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
        </button>
      </header>

      {/* What actually answered. Shown only after the first successful turn,
          so the header is not cluttered before there is anything to report. */}
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
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
            strokeWidth={1.8}
          />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{error}</p>
            <p className="mt-0.5 text-crewly-red/80">
              {ERROR_HINTS[errorCode] ||
                'Try again, or contact your HR team if this keeps happening.'}
            </p>
          </div>

          {/* 36.4 — retry. Shown on the error itself, where the person is
              already looking, and disabled while a send is in flight so two
              requests can never race. */}
          <button
            type="button"
            onClick={retry}
            disabled={sending}
            title="Ask again"
            className="flex shrink-0 items-center gap-1 rounded border border-crewly-red/40 px-2 py-1 text-[11px] font-semibold text-crewly-red transition hover:bg-crewly-red/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" strokeWidth={2} />
            Try again
          </button>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
        {shown.map((message) => (
          <ChatMessageBubble
            key={message.id}
            role={message.role}
            content={message.content}
            onCopy={
              message.id === lastAssistantId && message.id !== 'welcome'
                ? () => {}
                : undefined
            }
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

        <ChatInputBar onSend={send} sending={sending} value={draft} onChange={setDraft} />
      </div>
    </>
  );
};

export default AiAssistantPanel;
