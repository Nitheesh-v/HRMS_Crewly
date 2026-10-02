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
  getTeamAvailability,
} from '../../services/presenceService.js';

// INITIAL empty team state. Mirrors EMPTY_PRESENCE semantics — a missing
// key reads as "no team data loaded yet", never as "everyone is hidden".
export const EMPTY_TEAM_AVAILABILITY = Object.freeze({
  items: [],
  summary: {
    total: 0,
    byPresence: { available: 0, busy: 0, dnd: 0, unknown: 0 },
    byWorkLocation: { office: 0, wfh: 0, remote: 0 },
  },
  meta: {
    page: 1,
    pageSize: 25,
    pages: 1,
    totalPages: 1,
    totalItems: 0,
    total: 0,
    limit: 25,
  },
  config: {
    enabled: true,
    statusMessagesEnabled: true,
    workLocationEnabled: true,
    employeePresenceVisible: true,
  },
});

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

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.3 — TEAM AVAILABILITY (read-only thunk)
//
//  Identity-free payload. The query params are FILTER chips (search /
//  presence / workLocation / page / limit). The backend's
//  noQueryIdentityOverride validator rejects any attempt to pass
//  companyId/userId/employeeId; we never send them.
// ═══════════════════════════════════════════════════════════════════════════
export const fetchTeamAvailability = createAsyncThunk(
  'presence/fetchTeamAvailability',
  async (params = {}, { rejectWithValue }) => {
    try {
      const result = await getTeamAvailability(params);
      return result && result.data ? result.data : EMPTY_TEAM_AVAILABILITY;
    } catch (err) {
      return rejectWithValue({
        code: err.presenceCode || 'PRESENCE_TEAM_LOAD_FAILED',
        message: err.message || 'Could not load team availability.',
      });
    }
  },
);

const initialState = {
  current: EMPTY_PRESENCE,
  loading: 'idle', // 'idle' | 'pending' | 'fulfilled' | 'rejected'
  saving: 'idle',
  error: null,
  team: EMPTY_TEAM_AVAILABILITY,
  teamLoading: 'idle',
  teamError: null,
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
      })
      // 37.3 — team availability
      .addCase(fetchTeamAvailability.pending, (state) => {
        state.teamLoading = 'pending';
        state.teamError = null;
      })
      .addCase(fetchTeamAvailability.fulfilled, (state, action) => {
        state.teamLoading = 'fulfilled';
        state.team = action.payload || EMPTY_TEAM_AVAILABILITY;
        state.teamError = null;
      })
      .addCase(fetchTeamAvailability.rejected, (state, action) => {
        state.teamLoading = 'rejected';
        // Preserve the last good team snapshot. A failed refresh does
        // NOT wipe the table — the UI shows a toast and re-enables
        // the controls.
        state.teamError = action.payload || {
          code: 'PRESENCE_TEAM_LOAD_FAILED',
          message: 'Could not load team availability.',
        };
      });
  },
});

export const { clearError } = presenceSlice.actions;
export default presenceSlice.reducer;