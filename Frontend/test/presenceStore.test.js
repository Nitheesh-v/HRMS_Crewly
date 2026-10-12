// Phase 37.1 — Redux store wiring for the presence slice.
//
// The 36.3 page rendered blank because a slice was never registered; a
// destructure threw on first render. We do the same defensive check
// here so 37.2 cannot ship with the slice silently absent.
//
// This test also pins the slice's name in the store AND in the file, so
// a future refactor that renames the slice cannot pass for the wrong
// reason.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import store from '../src/redux/store.js';
import presenceReducer, {
  clearError,
  loadMyPresence,
  updateMyStatus,
  updateMyStatusMessage,
  updateMyWorkLocation,
} from '../src/redux/slices/presenceSlice.js';

describe('Phase 37.1 store wiring', () => {
  test('the presence slice IS registered on the real store', () => {
    const state = store.getState();
    assert.ok(state.presence, 'state.presence is missing from the store');
    assert.equal(state.presence.loading, 'idle');
    assert.equal(state.presence.saving, 'idle');
    assert.equal(state.presence.error, null);
    assert.ok(state.presence.current, 'state.presence.current is missing');
    // The default snapshot is `unknown`, NOT `offline` (Phase 37 §20).
    assert.equal(state.presence.current.presence, 'unknown');
    assert.equal(state.presence.current.livePresenceAvailable, false);
  });

  test('all expected thunks are exported', () => {
    assert.equal(typeof loadMyPresence, 'function');
    assert.equal(typeof updateMyStatus, 'function');
    assert.equal(typeof updateMyStatusMessage, 'function');
    assert.equal(typeof updateMyWorkLocation, 'function');
  });

  test('clearError reducer resets the error field', () => {
    const start = {
      ...presenceReducer(undefined, { type: '@@INIT' }),
      error: { code: 'X', message: 'oops' },
    };
    const next = presenceReducer(start, clearError());
    assert.equal(next.error, null);
  });

  test('rejected load does NOT overwrite the last good state', () => {
    const good = {
      ...presenceReducer(undefined, { type: '@@INIT' }),
      current: { ...presenceReducer(undefined, { type: '@@INIT' }).current, presence: 'busy' },
    };
    const next = presenceReducer(
      good,
      {
        type: loadMyPresence.rejected.type,
        payload: { code: 'PRESENCE_LOAD_FAILED', message: 'oops' },
      },
    );
    // current stays as busy
    assert.equal(next.current.presence, 'busy');
    assert.equal(next.error.code, 'PRESENCE_LOAD_FAILED');
  });

  test('fulfilled status update mutates the snapshot', () => {
    const start = presenceReducer(undefined, { type: '@@INIT' });
    const next = presenceReducer(start, {
      type: updateMyStatus.fulfilled.type,
      payload: { ...start.current, presence: 'dnd', manualStatus: 'dnd' },
    });
    assert.equal(next.current.presence, 'dnd');
    assert.equal(next.saving, 'fulfilled');
  });
});