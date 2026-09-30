// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — AI ASSISTANT CLIENT STATE
//
// SESSION-ONLY BY DESIGN (36.3 §11)
//   The conversation is React state held here for the life of the tab. It is
//   NOT persisted server-side and NOT written to localStorage: a chat about
//   leave balances must not outlive the browser session, and there is nowhere
//   in this app that wants to read it back later.
//
// The page keeps the messages array in local component state (it needs them
// during a single render) and mirrors them here so the slice stays the single
// source of truth for the two things the API reports back: usage and the
// categories the answer was built from.
// ═══════════════════════════════════════════════════════════════════════════

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';

import { askHRAssistant } from '../../services/aiService.js';

import { normalizeChatLanguage } from '../../components/AIAssistant/chatLanguages.js';

/**
 * One turn. `messages` is the WHOLE conversation, because the server is
 * stateless: it caps the history itself (the last 6 turns) and rebuilds the HR
 * context fresh on every call, so there is no server-side session to resume.
 */
export const sendChatMessage = createAsyncThunk(
  'aiChat/send',

  async ({ messages, categories, language }, { rejectWithValue }) => {
    try {
      // Normalized here as well as in the selector, so a value that
      // arrived some other way can never reach the server. The server
      // normalizes a third time; three cheap checks is the right price
      // for a field that must never be able to fail a question.
      // 36.6 — the service now also returns followUpQuestions and
      // deepLinks. Both are derived from things the server already knows
      // (the model's own reply, and the categories the retriever filled),
      // so nothing new is asked of the client and nothing is persisted.
      return await askHRAssistant({
        messages,
        categories,
        language: normalizeChatLanguage(language),
      });
    } catch (error) {
      // The code is what lets the page say "wait a moment" (RATE_LIMITED,
      // QUOTA_EXCEEDED) versus "ask HR" (everything else) honestly.
      return rejectWithValue({
        message: error?.message || 'The assistant could not answer.',
        code: error?.code || '',
        status: error?.status ?? null,
      });
    }
  },
);

const initialState = {
  messages: [], // [{ id, role: 'user'|'assistant', content }] — session only
  sending: false,
  error: '',
  errorCode: '',

  // null until the first successful turn. Surfaced in the header so the person
  // can see WHICH of their HR categories actually answered.
  categoriesUsed: [],

  // null until the first successful turn. Tokens only — never text.
  usage: null,

  // 36.5 — the reply language. A PRESENTATION preference, stored in Redux
  // only and deliberately NOT in localStorage: a language choice is not
  // sensitive, but this product keeps every chat-state key in memory, and
  // one exception would become the precedent for the next one.
  //
  // Defaulting to English here rather than reading a stored value means a
  // fresh tab always starts from the same honest place.
  language: 'en',

  // 36.6 — the suggestion chips and the navigation chips for the LAST
  // answer only. Older answers keep theirs in the message objects
  // themselves (see the fulfilled case), so scrolling back does not lose
  // them.
  followUpQuestions: [],

  // Navigation only. The assistant never performs an action.
  deepLinks: [],
};

const aiChatSlice = createSlice({
  name: 'aiChat',

  initialState,

  reducers: {
    messageAdded: (state, action) => {
      // 36.6 — the timestamp is stamped HERE, in the reducer, and not by
      // the caller. One place means every message gets one, including any
      // future dispatch site, and the transcript export can rely on it.
      state.messages.push({
        at: Date.now(),
        ...action.payload,
      });

      // A new turn clears the previous error, but NOT the usage/categories:
      // those describe the last ANSWER, which is still the one on screen.
      state.error = '';
      state.errorCode = '';
    },

    conversationCleared: (state) => {
      // Clear everything except usage. The token spend already happened and
      // hiding it would understate what the person has used this session.
      state.messages = [];
      state.error = '';
      state.errorCode = '';

      // 36.6 — the chips describe the last answer, and there is no last
      // answer any more. Leaving them would offer a navigation chip to a
      // screen the cleared conversation had nothing to do with.
      state.followUpQuestions = [];
      state.deepLinks = [];
    },

    languageSet: (state, action) => {
      // Normalized in the reducer, not just the caller, so the state can
      // never hold a value the selector would not offer. A bad payload
      // falls back to English instead of poisoning the next request.
      //
      // Clearing the messages would be wrong: the transcript already on
      // screen was answered in the previous language and is still true.
      // The new language applies to the NEXT answer.
      state.language = normalizeChatLanguage(action.payload);
    },
  },

  extraReducers: (builder) => {
    builder
      .addCase(sendChatMessage.pending, (state) => {
        state.sending = true;
        state.error = '';
        state.errorCode = '';
      })

      .addCase(sendChatMessage.fulfilled, (state, action) => {
        state.sending = false;

        // 36.6 — the chips are stored ON the message as well as at the top
        // level. Scrolling back to an earlier answer must not lose its
        // suggestions, and the top-level copy exists so the newest answer
        // does not have to be found by id.
        const followUps = Array.isArray(action.payload?.followUpQuestions)
          ? action.payload.followUpQuestions
          : [];

        const links = Array.isArray(action.payload?.deepLinks)
          ? action.payload.deepLinks
          : [];

        state.messages.push({
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: action.payload?.reply || '',
          at: Date.now(),
          followUpQuestions: followUps,
          deepLinks: links,
        });

        state.categoriesUsed = action.payload?.categoriesUsed || [];
        state.usage = action.payload?.usage ?? null;
        state.followUpQuestions = followUps;
        state.deepLinks = links;
      })

      .addCase(sendChatMessage.rejected, (state, action) => {
        state.sending = false;

        // Fail closed and honestly: no reply is appended, so the person can
        // never mistake an error message for the assistant's answer.
        state.error = action.payload?.message || 'The assistant could not answer.';
        state.errorCode = action.payload?.code || '';
      });
  },
});

export const {
  conversationCleared,
  languageSet,
  messageAdded,
} = aiChatSlice.actions;

export default aiChatSlice.reducer;
