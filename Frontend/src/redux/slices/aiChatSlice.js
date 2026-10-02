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

import {
  askHRAssistant,
  getChatLanguages,
} from '../../services/aiService.js';

import { normalizeChatLanguage } from '../../components/AIAssistant/chatLanguages.js';

/**
 * One turn. `messages` is the WHOLE conversation, because the server is
 * stateless: it caps the history itself (the last 6 turns) and rebuilds the HR
 * context fresh on every call, so there is no server-side session to resume.
 */
export const sendChatMessage = createAsyncThunk(
  'aiChat/send',

  async (
    { messages, categories, language },
    { getState, rejectWithValue },
  ) => {
    try {
      // Normalized here as well as in the selector, so a value that
      // arrived some other way can never reach the server. The server
      // normalizes a third time; three cheap checks is the right price
      // for a field that must never be able to fail a question.
      // 36.6 — the service now also returns followUpQuestions and
      // deepLinks. Both are derived from things the server already knows
      // (the model's own reply, and the categories the retriever filled),
      // so nothing new is asked of the client and nothing is persisted.
      // 36.7 — normalized against the tenant's own list, read from the
      // store. Without this, a language the admin has since switched off
      // would still be sent and come back a 400 the person cannot explain.
      const { allowedLanguages = [] } = getState().aiChat || {};

      return await askHRAssistant({
        messages,
        categories,
        language: normalizeChatLanguage(language, allowedLanguages),
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

/**
 * 36.7 — load the reply languages THIS tenant offers.
 *
 * Called once when the assistant first mounts. It deliberately swallows a
 * failure: the widget still has to open, and the honest fallback is the
 * default five, which is what an unconfigured tenant gets. A person seeing
 * five languages instead of ten is a much smaller problem than a widget
 * that will not open because a config read timed out.
 *
 * The catalogue is dropped on the floor here on purpose. It is only needed
 * to render the selector, and the selector gets its labels from
 * chatLanguages.js — the frontend's own copy, pinned to the backend's by a
 * test. Keeping one source for the records avoids two lists that can
 * disagree about a native name.
 */
export const loadChatLanguages = createAsyncThunk(
  'aiChat/loadLanguages',

  async (_arg, { rejectWithValue }) => {
    try {
      const { languages } = await getChatLanguages();

      return Array.isArray(languages) ? languages : [];
    } catch (error) {
      return rejectWithValue({
        message: error?.message || 'Could not load the language list.',
        code: error?.code || '',
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

  // 36.7 — the codes this tenant's admin enabled, from GET /ai/languages.
  //
  // Empty until the first successful load, which is exactly the same as
  // "unconfigured": chatLanguagesFor([]) returns the default five, so the
  // first paint is correct rather than blank.
  //
  // Not in localStorage. It is tenant state that belongs to the server, and
  // a stale copy would offer a language the admin has since switched off.
  allowedLanguages: [],

  // 36.7-fix — whether the assistant panel is open.
  //
  // LIFTED OUT OF THE WIDGET'S LOCAL useState so the SIDEBAR can open it too.
  // The floating button and the sidebar entry are two affordances for one
  // panel, and they cannot share a state that lives inside one of them.
  //
  // Redux rather than a module-level variable for the same reason as
  // everything else here: it is session state, it is inspectable, and it
  // resets with the store. NOT in localStorage — a panel that reopens itself
  // on every page load is a panel people learn to ignore.
  panelOpen: false,

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
      // 36.7 — normalized against THIS TENANT'S list, not the platform's.
      //
      // That distinction is the whole feature. A code that exists on the
      // platform but was never enabled for this company must fall back to
      // English here, because the validator will refuse it server-side and
      // the selector would otherwise be promising a language nobody can
      // actually get.
      //
      // Normalizing in the reducer rather than the caller means no dispatch
      // site can put an unoffered language into the state, however the
      // payload arrived.
      //
      // Clearing the messages would be wrong: the transcript already on
      // screen was answered in the previous language and is still true.
      // The new language applies to the NEXT answer.
      state.language = normalizeChatLanguage(
        action.payload,
        state.allowedLanguages,
      );
    },

    openAssistantPanel: (state) => {
      // Idempotent, and deliberately not clearing the conversation: opening
      // the panel is not the same action as starting a new one.
      state.panelOpen = true;
    },

    closeAssistantPanel: (state) => {
      state.panelOpen = false;
    },

    toggleAssistantPanel: (state) => {
      state.panelOpen = !state.panelOpen;
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
      })

      .addCase(loadChatLanguages.fulfilled, (state, action) => {
        // Kept as an array of codes even when empty: an empty list and a
        // never-loaded list are the same thing here, and both mean "offer
        // the default five".
        state.allowedLanguages = action.payload || [];
      })

      .addCase(loadChatLanguages.rejected, () => {
        // Deliberately leaves allowedLanguages as it was. A failed read
        // must not WIDEN the list to the platform catalogue, and it must not
        // clear a list that already loaded — either would offer a language
        // the server is not currently serving.
        //
        // It also does not set `state.error`. This is a background load for
        // a cosmetic preference; showing an error banner over the whole
        // widget because the language list was slow would be the wrong
        // trade, and the widget still works.
      });
  },
});

export const {
  closeAssistantPanel,
  conversationCleared,
  languageSet,
  messageAdded,
  openAssistantPanel,
  toggleAssistantPanel,
} = aiChatSlice.actions;

export default aiChatSlice.reducer;
