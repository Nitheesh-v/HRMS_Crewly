// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE SLICE (minimal prep for 37.2)
//
//  WHAT THIS MODULE IS
//    One redux-toolkit slice. The 37.2 widget reads `state.presence`
//    and dispatches its thunks. Nothing else is wired here yet.
//
//  WHY THIS SLICE EXISTS NOW
//    Phase 36 paid for a black-page bug because a new reducer was never
//    registered in store.js (capsule §4.10). Registering the slice in
//    37.1, even with just a load thunk and an EMPTY_PRESENCE default,
//    makes the registration visible to the registration pin test
//    (Frontend test/presenceService.test.js).
//
//  WHY NO `loading: true` STARTER-LIKE STATE
//    Phase 36 also paid for a "loading=true that never clears" trap.
//    The default is `idle`; loadMyPresence's pending→fulfilled clears
//    it. A failed mutation does NOT poison the slice; the error is stored
//    so the UI can render a toast and the controls re-enable.
// ═══════════════════════════════════════════════════════════════════════════

import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';

import { EMPTY_PRESENCE } from './presenceConstants.js';
import {
  getMyPresence,
  setMyStatus,
  setMyStatusMessage,
  setMyWorkLocation,
} from '../../services/presenceService.js';

export const loadMyPresence = createAsyncThunk(
  'presence/loadMyPresence',
  async (_, { rejectWithValue }) => {
    try {
      const result = await getMyPresence();
      return result && result.data ? result.data : EMPTY_PRESENCE;
    } catch (err) {
      return rejectWithValue({
        code: err.presenceCode || 'PRESENCE_LOAD_FAILED',
        message: err.message || 'Could not load presence.',
      });
    }
  },
);

export const updateMyStatus = createAsyncThunk(
  'presence/updateMyStatus',
  async ({ status, expiresAt } = {}, { rejectWithValue }) => {
    try {
      const result = await setMyStatus({ status, expiresAt });
      return result && result.data ? result.data : null;
    } catch (err) {
      return rejectWithValue({
        code: err.presenceCode || 'PRESENCE_UPDATE_FAILED',
        message: err.message || 'Could not update status.',
      });
    }
  },
);

export const updateMyStatusMessage = createAsyncThunk(
  'presence/updateMyStatusMessage',
  async ({ message, expiresAt } = {}, { rejectWithValue }) => {
    try {
      const result = await setMyStatusMessage({ message, expiresAt });
      return result && result.data ? result.data : null;
    } catch (err) {
      return rejectWithValue({
        code: err.presenceCode || 'PRESENCE_UPDATE_FAILED',
        message: err.message || 'Could not update status message.',
      });
    }
  },
);

export const updateMyWorkLocation = createAsyncThunk(
  'presence/updateMyWorkLocation',
  async ({ location, expiresAt } = {}, { rejectWithValue }) => {
    try {
      const result = await setMyWorkLocation({ location, expiresAt });
      return result && result.data ? result.data : null;
    } catch (err) {
      return rejectWithValue({
        code: err.presenceCode || 'PRESENCE_UPDATE_FAILED',
        message: err.message || 'Could not update work location.',
      });
    }
  },
);

const initialState = {
  current: EMPTY_PRESENCE,
  loading: 'idle', // 'idle' | 'pending' | 'fulfilled' | 'rejected'
  saving: 'idle',
  error: null,
};

const presenceSlice = createSlice({
  name: 'presence',
  initialState,
  reducers: {
    clearError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadMyPresence.pending, (state) => {
        state.loading = 'pending';
        state.error = null;
      })
      .addCase(loadMyPresence.fulfilled, (state, action) => {
        state.loading = 'fulfilled';
        state.current = action.payload || EMPTY_PRESENCE;
        state.error = null;
      })
      .addCase(loadMyPresence.rejected, (state, action) => {
        state.loading = 'rejected';
        // Preserve the last good state. The UI shows an error toast; the
        // snapshot we already have is not overwritten.
        state.error = action.payload || {
          code: 'PRESENCE_LOAD_FAILED',
          message: 'Could not load presence.',
        };
      })
      .addCase(updateMyStatus.pending, (state) => {
        state.saving = 'pending';
        state.error = null;
      })
      .addCase(updateMyStatus.fulfilled, (state, action) => {
        state.saving = 'fulfilled';
        if (action.payload) state.current = action.payload;
      })
      .addCase(updateMyStatus.rejected, (state, action) => {
        state.saving = 'rejected';
        state.error = action.payload || {
          code: 'PRESENCE_UPDATE_FAILED',
          message: 'Could not update status.',
        };
      })
      .addCase(updateMyStatusMessage.pending, (state) => {
        state.saving = 'pending';
        state.error = null;
      })
      .addCase(updateMyStatusMessage.fulfilled, (state, action) => {
        state.saving = 'fulfilled';
        if (action.payload) state.current = action.payload;
      })
      .addCase(updateMyStatusMessage.rejected, (state, action) => {
        state.saving = 'rejected';
        state.error = action.payload || {
          code: 'PRESENCE_UPDATE_FAILED',
          message: 'Could not update status message.',
        };
      })
      .addCase(updateMyWorkLocation.pending, (state) => {
        state.saving = 'pending';
        state.error = null;
      })
      .addCase(updateMyWorkLocation.fulfilled, (state, action) => {
        state.saving = 'fulfilled';
        if (action.payload) state.current = action.payload;
      })
      .addCase(updateMyWorkLocation.rejected, (state, action) => {
        state.saving = 'rejected';
        state.error = action.payload || {
          code: 'PRESENCE_UPDATE_FAILED',
          message: 'Could not update work location.',
        };
      });
  },
});

export const { clearError } = presenceSlice.actions;
export default presenceSlice.reducer;