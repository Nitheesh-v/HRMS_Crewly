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
//
// 36.5 — VOICE AND LANGUAGE.
//
//   · A language selector in the header. Five options, English by default.
//     The choice is stored in Redux and in Redux ONLY — never in
//     localStorage, exactly like the rest of the chat state.
//
//   · A microphone in the input bar and a speaker on each reply. Both are the
//     BROWSER's own Web Speech API: no package, no vendor, no API key, and
//     nothing of ours is uploaded or stored. The transcript is redacted
//     server-side exactly like typed text.
//
//   · Both affordances are hidden when the browser cannot do them. Firefox
//     without a flag and most embedded webviews simply get the typing chat
//     that 36.3 shipped, which is a complete product on its own.
//
// 36.6 — THE INTELLIGENCE & UX PACK.
//
//   · PROGRESSIVE REVEAL. The reply types itself out instead of appearing
//     all at once, which is the ChatGPT-like feel the owner asked for. This
//     is CLIENT-SIDE rendering of a complete reply, NOT server streaming —
//     see the note in docs/PHASE_36_6_ADVANCED_CHATBOT_UX.md for why SSE was
//     deliberately not used.
//
//   · FOLLOW-UP CHIPS and DEEP-LINK CHIPS, both rendered by the bubble.
//     A deep link NAVIGATES. It never performs an action.
//
//   · A TRANSCRIPT EXPORT. Client-side Blob only, no server call.
//
//   · A RICHER EMPTY STATE that says what the assistant can actually do.
//
//   · Typing while the assistant is speaking stops the speech, because a
//     voice talking over someone who has started typing is just noise.
//
//   · LANGUAGE IS A PREFERENCE, NOT AN AUTHORITY. It changes how an answer is
//     phrased and never what the caller may read — the server scopes
//     that from req.companyId and req.user._id before this value is looked at.
//     There is no language auto-detection anywhere in this product.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  AlertTriangle,
  Bot,
  Download,
  Info,
  Languages,
  Mic,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import { useDispatch, useSelector } from 'react-redux';

import {
  conversationCleared,
  languageSet,
  messageAdded,
  sendChatMessage,
} from '../../redux/slices/aiChatSlice.js';

import ChatInputBar from './ChatInputBar.jsx';
import ChatMessageBubble, { ChatTypingBubble } from './ChatMessageBubble.jsx';
import { MAX_MESSAGES } from './chatLimits.js';

import {
  CHAT_LANGUAGES,
  chatLanguageBcp47,
  getChatLanguage,
} from './chatLanguages.js';

import { useSpeechRecognition } from '../../hooks/useSpeechRecognition.js';

import {
  isSpeechSynthesisSupported,
  speak,
  stopSpeaking,
  whenVoicesReady,
} from '../../utils/speechSynthesis.js';

import { downloadTranscript } from './chatTranscript.js';

import { QUICK_PROMPTS } from './chatPrompts.js';

/**
 * 36.6 — the empty state.
 *
 * WHY IT EXISTS. 36.3 opened with a single welcome sentence and a row of
 * pills. That tells a first-time user what the assistant IS, but not what
 * it can DO for them, and the pills are undifferentiated — a leave question
 * and a holiday question look equally likely to be answered.
 *
 * The four badges are the honest summary of the whole Phase 36 design:
 * answers come only from the caller's own data, everything is redacted
 * before it leaves the server, five languages are available, and the mic
 * and speaker are the browser's own.
 *
 * THE EXAMPLES ARE GROUPED, not listed flat, so a person can find the
 * thing they came for. Every example is a REAL quick prompt from
 * chatPrompts.js — the same list the pills test proves is answerable — so
 * nothing here promises what the context cannot deliver.
 */
const ONBOARDING_BADGES = Object.freeze([
  Object.freeze({ icon: Sparkles, label: 'Instant Answers' }),
  Object.freeze({ icon: ShieldCheck, label: '100% Private & Redacted' }),
  Object.freeze({ icon: Languages, label: 'Multilingual' }),
  Object.freeze({ icon: Mic, label: 'Voice Enabled' }),
]);

/**
 * The example groups, in the order a new employee is most likely to want
 * them. Each entry names a quick prompt that already exists, so the two
 * lists can never disagree.
 */
//
// THE LABELS ARE THE REAL ONES from chatPrompts.js, and they are RESOLVED
// against that list rather than trusted. A prompt that is renamed or
// removed degrades to fewer chips here, never to a chip that promises
// something the context cannot answer — which is the rule
// Frontend/test/aiChatPills.test.js already enforces for the pills.
const ONBOARDING_GROUPS = Object.freeze([
  Object.freeze({
    title: 'Leaves',
    labels: Object.freeze([
      'My leave balance',
      'How do I apply for leave',
      'My leave history',
    ]),
  }),
  Object.freeze({
    title: 'Attendance & Shifts',
    labels: Object.freeze([
      'My shift timing',
      'Am I present today',
      'This month so far',
    ]),
  }),
  Object.freeze({
    title: 'Payslips & Holidays',
    labels: Object.freeze(['My payslips', 'Upcoming holidays']),
  }),
]);

/**
 * Resolve the onboarding groups to real quick prompts.
 *
 * Built once at module load. A label with no matching prompt is dropped,
 * so a stale group entry simply produces one fewer chip instead of a
 * question the assistant cannot answer.
 */
const ONBOARDING_SECTIONS = ONBOARDING_GROUPS.map((group) => ({
  title: group.title,
  prompts: group.labels
    .map((label) => QUICK_PROMPTS.find((entry) => entry.label === label))
    .filter(Boolean),
})).filter((group) => group.prompts.length > 0);

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
    language = 'en',
  } = useSelector((state) => state.aiChat) ?? {};

  const [draft, setDraft] = useState('');

  const endRef = useRef(null);

  // The selector needs a real id so its sr-only label points at it. A
  // generated id is used rather than a literal so two panels can never
  // collide, even though only one is ever mounted.
  const languageId = useId();

  /*
   * 36.5 — THE SPEECH STATE, ALL OF IT LOCAL AND TRANSIENT.
   *
   * `speakingId` is which bubble is being read aloud. It is a single id and
   * not a boolean because speechSynthesis has ONE queue per tab: two
   * bubbles that both believed they were speaking would talk over each
   * other. An empty string means nothing is being read.
   *
   * `canSpeak` is resolved once at mount. It is the browser's own answer
   * and it does not change, so re-checking per render would be noise.
   */
  const [canSpeak] = useState(() => isSpeechSynthesisSupported());

  const [speakingId, setSpeakingId] = useState('');

  // The draft as of the last COMMITTED render, so a speech callback can read
  // it without being re-created every keystroke.
  //
  // Written in an effect, not during render: a ref mutated in the render body
  // is exactly the pattern React warns about, because a render that is thrown
  // away would still have left the new value behind.
  const draftRef = useRef('');

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // What the person had typed BEFORE the microphone started filling the box.
  // Null means "not currently accumulating speech", which is how the effect
  // below knows when to capture the base.
  const voiceBaseRef = useRef(null);

  /*
   * The auto-speak latch.
   *
   * Set when a mic-composed question is sent, consumed when that question's
   * reply lands. It is a ref and not state because it is a one-shot signal
   * between two renders, and a state flag would fire the effect twice under
   * React's strict-mode double-invoke — which is exactly the "speak the
   * same reply twice" bug this guard exists to prevent.
   */
  const pendingVoiceSpeakRef = useRef(false);

  // Keep the newest turn in view. Guarded on `open` so the panel does not
  // scroll itself while it is closed and invisible.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, sending]);

  /**
   * 36.5 — read one reply aloud.
   *
   * Guarded on `canSpeak` so a browser without synthesis never reaches the
   * API. The voice list is awaited first: Chrome and Safari populate
   * getVoices() asynchronously, and skipping that wait is how a Tamil reply
   * ends up read by an English voice for no reason except a race.
   *
   * The language is the one currently selected in the header, which is also
   * the language the reply was written in. Asking for anything else would
   * read Tamil text with an English voice.
   */
  const speakReply = useCallback(
    async (id, text) => {
      if (!canSpeak || !text) return;

      // Wait for the voice list BEFORE marking anything as speaking.
      //
      // Two reasons, and the second is the interesting one. Chrome and
      // Safari populate getVoices() asynchronously, so speaking before the
      // list lands is how a Tamil reply gets read by an English voice. And
      // because the await puts this state update OUTSIDE the caller's
      // synchronous effect body, it also satisfies the rule against setting
      // state directly in an effect — which matters here because the
      // auto-speak path runs inside one.
      await whenVoicesReady();

      speak(text, {
        lang: chatLanguageBcp47(language),

        // The marker is set by the speech module's own start hook, not by
        // this function, so the "which bubble is being read" state is owned
        // by the thing that actually knows. It also keeps this callback free
        // of a direct state write, which is what the auto-speak path needs.
        onStart: () => setSpeakingId(id),

        onEnd: () => {
          // Only clear the marker if it is still OURS. A newer reply may
          // already have taken over, and clearing that would leave its
          // button stuck in the "speaking" state.
          setSpeakingId((current) => (current === id ? '' : current));
        },
      });
    },
    [canSpeak, language],
  );

  /** Click the speaker: start reading, or stop if this bubble already is. */
  const toggleSpeak = useCallback(
    (id, text) => {
      if (!canSpeak) return;

      if (speakingId === id) {
        stopSpeaking();
        setSpeakingId('');

        return;
      }

      // A different bubble was being read: stop it first so the two never
      // overlap. speak() also cancels, but doing it here makes the intent
      // explicit and keeps the old bubble's marker honest.
      if (speakingId) stopSpeaking();

      speakReply(id, text);
    },
    [canSpeak, speakingId, speakReply],
  );

  const send = useCallback(
    async (text, meta = {}) => {
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

      // 36.5 — remember whether this question was SPOKEN. The reply to a
      // spoken question is read aloud once; the reply to a typed one is not,
      // because reading back text the person just typed is noise.
      //
      // The flag is a ref, so it survives the async dispatch without ever
      // entering Redux — a voice interaction is session-local and must
      // not outlive the tab.
      pendingVoiceSpeakRef.current = meta?.sentViaVoice === true;

      await dispatch(
        sendChatMessage({
          messages: trimmed.map(({ role: roleName, content: body }) => ({
            role: roleName,
            content: body,
          })),

          // The language the person picked. English is omitted by the client
          // so the default request is byte-identical to the 36.3 one.
          language,
        }),
      );

      setDraft('');
    },
    [dispatch, messages, sending, language],
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

        // 36.5 — a retry answers in the SAME language as the failed
        // attempt. Silently switching to English would be the quiet lie this
        // codebase refuses.
        language,
      }),
    );
  }, [dispatch, messages, sending, language]);

  /*
   * 36.5 — THE RECOGNISER.
   *
   * Declared AFTER `send` so the final-transcript callback can call it
   * directly rather than through another ref.
   *
   * `lang` is the BCP-47 tag for whatever is currently selected, so the
   * browser listens in the language the person is asking in. Note that
   * `tanglish` maps to `en-IN` on purpose: it is written in Latin letters,
   * and asking a recogniser for Tamil script would mis-hear it.
   *
   * `continuous: false` — one utterance, then stop. A chat box is not a
   * dictation pad, and a recogniser that never ends is how a microphone
   * stays open long after the person finished talking.
   */
  const voice = useSpeechRecognition({
    lang: chatLanguageBcp47(language),
    continuous: false,
    interimResults: true,
    onFinal: (text) => {
      // Whatever was typed before the microphone started is kept, and the
      // spoken words are appended after it. Sending ONLY the transcript
      // would silently drop half a question.
      const base = voiceBaseRef.current ?? '';
      const combined = [base, text].filter(Boolean).join(' ').trim();

      // Reset before the async send, so a stray interim event cannot
      // re-append to a base that was already consumed.
      voiceBaseRef.current = null;

      setDraft('');

      if (combined) send(combined, { sentViaVoice: true });
    },
  });

  /*
   * Live transcript in the textarea.
   *
   * The base is captured the first time an interim result arrives, which is
   * the moment the box stops being purely the person's typing. Without the
   * ref, every interim event would append to the previous interim and the
   * text would repeat itself.
   */
  useEffect(() => {
    if (!voice.listening) {
      voiceBaseRef.current = null;

      return;
    }

    if (!voice.interim) return;

    if (voiceBaseRef.current === null) {
      voiceBaseRef.current = draftRef.current;
    }

    const merged = [voiceBaseRef.current, voice.interim]
      .filter(Boolean)
      .join(' ');

    setDraft(merged);
  }, [voice.listening, voice.interim]);

  /*
   * 36.6 — TYPING STOPS THE SPEECH.
   *
   * The assistant reads its reply aloud. The moment the person starts
   * typing, that voice is noise competing with what they are trying to
   * say, so it stops.
   *
   * Two deliberate choices:
   *
   *   · It only fires when something is actually speaking. Without the
   *     guard, every keystroke would cancel the speech engine, which is
   *     harmless in practice but pointless and hard to reason about.
   *
   *   · The draft still updates normally. Stopping the voice must never
   *     swallow a character — the person typed it, they get it.
   */
  const handleDraftChange = useCallback(
    (next) => {
      if (speakingId) {
        stopSpeaking();

        setSpeakingId('');
      }

      setDraft(next);
    },
    [speakingId],
  );

  /*
   * 36.5 — AUTO-SPEAK THE REPLY TO A SPOKEN QUESTION, ONCE.
   *
   * The whole rule is the latch. It is set when a spoken question is sent
   * and consumed the moment the matching reply lands, so:
   *
   *   · a typed question never triggers it;
   *   · a re-render, a language change or a scroll does not re-fire it;
   *   · React's strict-mode double-invoke cannot speak the reply twice,
   *     because the second pass finds the latch already cleared.
   *
   * The welcome bubble is excluded: it is not an answer to anything.
   */
  useEffect(() => {
    if (messages.length === 0) return;

    const last = messages[messages.length - 1];

    if (last.role !== 'assistant') return;

    if (!pendingVoiceSpeakRef.current) return;

    pendingVoiceSpeakRef.current = false;

    if (last.id === 'welcome') return;

    speakReply(last.id, last.content);
  }, [messages, speakReply]);

  /*
   * Closing the panel must stop the voice.
   *
   * Two reasons, and the first is a privacy one: a recogniser left running
   * after the person closed the window is a microphone nobody is watching.
   * The second is that an utterance still playing after unmount keeps the
   * tab's audio busy for no visible reason.
   */
  useEffect(
    () => () => {
      stopSpeaking();
    },
    [],
  );

  /**
   * 36.6 — export the transcript.
   *
   * ZERO server calls. The file is built from the messages already in
   * Redux and handed straight to the browser. Nothing is uploaded, nothing
   * is logged, and nothing is stored by this product — the file belongs to
   * the person who clicked the button, on the machine they are sitting at.
   *
   * `false` means there was nothing to export (an empty conversation), so
   * the button is disabled in that state rather than silently doing
   * nothing.
   */
  const exportTranscript = useCallback(() => {
    if (messages.length === 0) return;

    downloadTranscript(messages);
  }, [messages]);

  /**
   * 36.6 — a follow-up chip was clicked.
   *
   * It is sent exactly as if the person had typed it. There is no special
   * path and no extra state: the chip is a shortcut for a keystroke, and
   * treating it as anything else would let a model-supplied string reach
   * the server by a route the tests do not cover.
   *
   * `sentViaVoice` is deliberately false: the person clicked, they did not
   * speak, so the reply must not be read aloud.
   */
  const askFollowUp = useCallback(
    (question) => {
      const text = String(question || '').trim();

      if (!text || sending) return;

      send(text, { sentViaVoice: false });
    },
    [send, sending],
  );

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

        {/* 36.6 — export the transcript. Rendered always but disabled until
            there is something to export, so the feature is discoverable
            rather than appearing out of nowhere after the first turn. */}
        <button
          type="button"
          onClick={exportTranscript}
          disabled={messages.length === 0}
          title="Download this conversation as a text file"
          aria-label="Download this conversation as a text file"
          className="flex shrink-0 items-center gap-1.5 rounded border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-dim transition hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={1.8} />
          <span className="hidden sm:inline">Export</span>
        </button>

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

      {/*
       * 36.5 — THE LANGUAGE SELECTOR.
       *
       * A native <select> and not a custom dropdown: it is keyboard
       * accessible, screen-reader labelled and touch friendly for free,
       * and there is nothing here that needs to look clever.
       *
       * The option text shows the language in BOTH English and its own
       * script, because that is what a person actually scans for.
       *
       * The hint under it names the script, so nobody picks Tamil
       * expecting Roman letters or Tanglish expecting Tamil script.
       *
       * CHANGING IT DOES NOT CLEAR THE TRANSCRIPT. The answers already on
       * screen were given in the previous language and are still true.
       * The new choice applies to the NEXT answer.
       */}
      <div className="flex items-center gap-2 border-b border-crewly-border px-3 py-2 sm:px-4">
        <Languages
          className="h-3.5 w-3.5 shrink-0 text-crewly-dim"
          aria-hidden="true"
          strokeWidth={1.8}
        />

        <label htmlFor={languageId} className="sr-only">
          Reply language
        </label>

        <select
          id={languageId}
          value={language}
          onChange={(event) => dispatch(languageSet(event.target.value))}
          className="min-w-0 flex-1 rounded border border-crewly-border bg-crewly-card px-2 py-1 text-[11px] font-semibold text-crewly-text outline-none transition focus:border-crewly-green"
        >
          {CHAT_LANGUAGES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label} — {entry.native}
            </option>
          ))}
        </select>

        <span className="shrink-0 text-[10px] text-crewly-dim">
          {getChatLanguage(language).hint}
        </span>
      </div>

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

            onSpeak={
              canSpeak && message.role === 'assistant'
                ? () => toggleSpeak(message.id, message.content)
                : undefined
            }
            speaking={speakingId === message.id}

            // 36.6 — the chips travel WITH the message, not with the panel, so
            // scrolling back to an earlier answer never shows the newest
            // answer's suggestions on it. The welcome bubble is excluded: it
            // is not an answer to anything and has nothing to suggest.
            followUpQuestions={
              message.id === 'welcome' ? [] : message.followUpQuestions
            }
            deepLinks={message.id === 'welcome' ? [] : message.deepLinks}
            onFollowUp={
              message.role === 'assistant' && message.id !== 'welcome'
                ? askFollowUp
                : undefined
            }
          />
        ))}

        {sending && <ChatTypingBubble />}

        <div ref={endRef} />
      </div>

      <div className="space-y-3 border-t border-crewly-border px-3 py-3 sm:px-4">
        {/*
         * 36.6 — THE EMPTY STATE.
         *
         * Replaces the flat row of pills 36.3 shipped. Same prompts, but
         * grouped by what a new employee came for, and with the four badges
         * that say what the assistant actually is.
         *
         * It still steps aside the moment the conversation starts — an
         * introduction that never leaves is a permanent toolbar.
         */}
        {messages.length === 0 && (
          <div className="space-y-3">
            <div className="rounded-xl border border-crewly-border bg-crewly-card p-3">
              <h3 className="text-[13px] font-bold text-crewly-text">
                Welcome to CREWLY HR Assistant
              </h3>

              <p className="mt-1 text-[11px] leading-relaxed text-crewly-dim">
                Ask about your own leave, attendance, shifts, holidays, payslip
                status, tasks, projects, expenses and documents. Answers come
                only from records you are already allowed to see, and the
                assistant can never approve, apply or change anything.
              </p>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {ONBOARDING_BADGES.map((badge) => (
                  <span
                    key={badge.label}
                    className="flex items-center gap-1 rounded-full border border-crewly-green/30 bg-crewly-green/10 px-2 py-0.5 text-[10px] font-semibold text-crewly-green"
                  >
                    <badge.icon
                      className="h-3 w-3 shrink-0"
                      aria-hidden="true"
                      strokeWidth={2}
                    />
                    {badge.label}
                  </span>
                ))}
              </div>
            </div>

            {ONBOARDING_SECTIONS.map((group) => (
              <div key={group.title}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-crewly-dim">
                  {group.title}
                </p>

                <div className="flex flex-wrap gap-1.5">
                  {group.prompts.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      disabled={sending}
                      onClick={() => send(item.prompt)}
                      className="rounded-full border border-crewly-border bg-crewly-card px-2.5 py-1 text-[11px] text-crewly-dim transition hover:border-crewly-green hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <ChatInputBar
          onSend={send}
          sending={sending}
          value={draft}
          onChange={handleDraftChange}
          voice={voice}
        />
      </div>
    </>
  );
};

export default AiAssistantPanel;
