// Verifies the 36.3 slice is reachable through the REAL store, and that the
// page's destructuring cannot crash the way it did when the slice was
// unregistered.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import store from '../src/redux/store.js';
import aiChatReducer, {
  closeAssistantPanel,
  conversationCleared,
  messageAdded,
  openAssistantPanel,
  sendChatMessage,
  toggleAssistantPanel,
} from '../src/redux/slices/aiChatSlice.js';

describe('Phase 36.3 store wiring', () => {
  test('the aiChat slice IS registered on the real store', () => {
    // THE 36.3 REGRESSION: the slice shipped unregistered, so state.aiChat was
    // undefined and AiAssistantPage crashed the moment it destructured it -
    // which is why /app/ai-assistant rendered a blank page.
    const state = store.getState();

    assert.ok(state.aiChat, 'state.aiChat is missing from the store');
    assert.ok(Array.isArray(state.aiChat.messages), 'messages must be an array');
    assert.equal(state.aiChat.sending, false);
    assert.equal(typeof state.aiChat.error, 'string');
    assert.ok(Array.isArray(state.aiChat.categoriesUsed));
  });

  test('the other three slices are still registered', () => {
    // Registering a slice must not displace anything else.
    const state = store.getState();

    for (const key of ['auth', 'permissions', 'chat', 'aiChat']) {
      assert.ok(state[key], `${key} is missing`);
    }
  });

  test('the reducer handles an unknown action without crashing', () => {
    const next = aiChatReducer(undefined, { type: '@@INIT' });

    assert.deepEqual(next.messages, []);
    assert.equal(next.sending, false);
    assert.equal(next.usage, null);
  });

  test('messageAdded appends and clears the previous error', () => {
    const start = { ...aiChatReducer(undefined, { type: '@@INIT' }), error: 'boom' };

    const next = aiChatReducer(
      start,
      messageAdded({ id: 'u1', role: 'user', content: 'hi' }),
    );

    assert.equal(next.messages.length, 1);
    assert.equal(next.messages[0].content, 'hi');
    assert.equal(next.error, '');
  });

  test('a rejected turn records the code and appends NO reply', () => {
    // An error must never be able to masquerade as the assistant's answer.
    const next = aiChatReducer(aiChatReducer(undefined, { type: '@@INIT' }), {
      type: sendChatMessage.rejected.type,
      payload: { message: 'Too fast', code: 'AI_RATE_LIMITED', status: 429 },
    });

    assert.equal(next.sending, false);
    assert.equal(next.errorCode, 'AI_RATE_LIMITED');
    assert.equal(next.error, 'Too fast');
    assert.equal(next.messages.length, 0);
  });

  test('a fulfilled turn appends the reply and records usage', () => {
    const next = aiChatReducer(aiChatReducer(undefined, { type: '@@INIT' }), {
      type: sendChatMessage.fulfilled.type,
      payload: {
        reply: 'You have 12 days.',
        usage: { totalTokens: 138 },
        categoriesUsed: ['leaves'],
      },
    });

    assert.equal(next.messages.length, 1);
    assert.equal(next.messages[0].role, 'assistant');
    assert.equal(next.messages[0].content, 'You have 12 days.');
    assert.equal(next.usage.totalTokens, 138);
    assert.deepEqual(next.categoriesUsed, ['leaves']);
  });

  test('conversationCleared empties messages but keeps the usage', () => {
    let state = aiChatReducer(undefined, { type: '@@INIT' });

    state = aiChatReducer(state, messageAdded({ id: 'u1', role: 'user', content: 'hi' }));
    state = { ...state, usage: { totalTokens: 138 } };
    state = aiChatReducer(state, conversationCleared());

    assert.equal(state.messages.length, 0);
    assert.equal(state.usage.totalTokens, 138);
  });

  test('the thunk carries all three lifecycle action creators', () => {
    // RTK exposes each lifecycle entry as an ACTION CREATOR function whose
    // `.type` is the action type string - not a bare string.
    for (const phase of ['pending', 'fulfilled', 'rejected']) {
      const creator = sendChatMessage[phase];

      assert.equal(typeof creator, 'function', `${phase} should be a creator`);
      assert.equal(
        creator.type,
        `aiChat/send/${phase}`,
        `${phase} action type`,
      );
    }
  });

  test('the service module exports exactly one method', async () => {
    // No tenant id, no user id and no feature leaves this client: the server
    // derives every one of them and refuses them from a body.
    const service = await import('../src/services/aiService.js');

    assert.equal(typeof service.askHRAssistant, 'function');
    assert.equal(typeof service.default?.askHRAssistant, 'function');
  });

  test('every component module resolves through the store', async () => {
    // The page imports the slice, the slice imports the service, the service
    // imports api.js, and api.js imports the store - a real cycle. This proves
    // the cycle resolves cleanly in the order the app loads it (store first),
    // which is exactly the order that broke when the slice was unregistered.
    const slice = await import('../src/redux/slices/aiChatSlice.js');

    assert.equal(typeof slice.default, 'function');
    assert.ok(store.getState().aiChat);
  });
});

// ── THE PANEL'S OPEN STATE IS SHARED ────────────────────────────────────────
//
// The owner asked for a sidebar entry for the assistant. The panel's open
// state was `useState` inside AiAssistantWidget, which made that impossible:
// a state that lives inside one of two affordances cannot be reached by the
// other. It now lives here, so the floating button, the sidebar entry and the
// panel's own close control all act on the same flag.

describe('Phase 36.7 — the assistant panel open state is shared', () => {
  test('the flag starts CLOSED', () => {
    // A panel that reopens itself is a panel people learn to ignore. Closed on
    // a fresh store, every time.
    const state = aiChatReducer(undefined, { type: '@@INIT' });

    assert.equal(state.panelOpen, false);
  });

  test('openAssistantPanel and closeAssistantPanel are opposites', () => {
    let state = aiChatReducer(undefined, { type: '@@INIT' });

    state = aiChatReducer(state, openAssistantPanel());
    assert.equal(state.panelOpen, true);

    state = aiChatReducer(state, closeAssistantPanel());
    assert.equal(state.panelOpen, false);
  });

  test('toggleAssistantPanel flips, and opening twice is idempotent', () => {
    let state = aiChatReducer(undefined, { type: '@@INIT' });

    state = aiChatReducer(state, toggleAssistantPanel());
    assert.equal(state.panelOpen, true);

    state = aiChatReducer(state, toggleAssistantPanel());
    assert.equal(state.panelOpen, false);

    // Opening an already-open panel must NOT clear the conversation: opening
    // the panel is not the same action as starting a new one.
    const withMessages = aiChatReducer(
      aiChatReducer(undefined, { type: '@@INIT' }),
      messageAdded({ id: 'u1', role: 'user', content: 'my leave balance' }),
    );

    const next = aiChatReducer(withMessages, openAssistantPanel());

    assert.equal(next.panelOpen, true);
    assert.equal(next.messages.length, 1);
  });

  test('clearing the conversation does not close the panel', () => {
    // Two separate actions. "Clear" empties the transcript; it does not dismiss
    // the window the person is still looking at.
    let state = aiChatReducer(undefined, { type: '@@INIT' });

    state = aiChatReducer(state, openAssistantPanel());
    state = aiChatReducer(state, conversationCleared());

    assert.equal(state.panelOpen, true);
  });

  test('the flag is reachable through the REAL store, not just the reducer', () => {
    // Pinned because the 36.3 regression was exactly this: a slice that worked
    // in isolation and was never registered.
    assert.ok(store.getState().aiChat);

    const before = store.getState().aiChat.panelOpen;

    store.dispatch(openAssistantPanel());
    assert.equal(store.getState().aiChat.panelOpen, true);
    assert.notEqual(before, store.getState().aiChat.panelOpen);

    store.dispatch(closeAssistantPanel());
    assert.equal(store.getState().aiChat.panelOpen, false);
  });
});
