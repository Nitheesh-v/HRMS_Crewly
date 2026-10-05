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
  getTenantConfig,
  updateTenantConfig,
} from '../../services/presenceService.js';
import workLocationRequestService from '../../services/presence/workLocationRequestService.js';

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
      // The api.js response interceptor ALREADY unwraps `body.data`,
      // so `result` IS the snapshot. The previous version re-checked
      // `result.data`, which was always undefined after the unwrap,
      // and returned EMPTY_PRESENCE on every load — the slice never
      // saw the saved status and the topbar badge always read
      // "unknown". That is the user-reported "where do I see the
      // saved data" symptom. Return `result` directly.
      const result = await getMyPresence();
      return result || EMPTY_PRESENCE;
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
      // Same as loadMyPresence: the interceptor unwraps `data`, so
      // `result` IS the new snapshot. Returning `result.data` was
      // always undefined, so the slice never updated after a save.
      const result = await setMyStatus({ status, expiresAt });
      return result || null;
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
      return result || null;
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
      return result || null;
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
      // The team response is paginated (items + summary + meta + config).
      // The api.js interceptor returns the full body when `meta` is
      // present (it preserves pagination shape). So `result` IS the
      // team payload; re-checking `result.data` was always undefined.
      const result = await getTeamAvailability(params);
      return result || EMPTY_TEAM_AVAILABILITY;
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
  // 37.4 — last debounced team-refetch bump from the realtime
  // runtime. TeamAvailabilityPage watches this and re-fetches.
  teamBumpedAt: null,
  // 37.5 — Work-location request sub-state. Lives inside the
  // existing presence slice (no new top-level redux key).
  workLocationRequests: {
    myRequests: [],
    reviewQueue: [],
    byId: {},
    submitting: 'idle',
    decisionPending: 'idle',
    loading: 'idle',
    loadingQueue: 'idle',
    error: null,
    lastDecidedId: null,
  },
  // Phase 37.7 — Tenant admin config sub-state. The admin page reads
  // / writes this; the rest of the app reads `state.presence.config.data`
  // to learn whether presence / work-location / status messages are
  // enabled.
  //
  // `dirty` is NOT stored here — per-field dirty lives in the page
  // component (Phase 36 paid for the page-wide dirty bug; we use a
  // per-key diff in the page and only send changed keys).
  config: {
    data: null,
    loading: 'idle', // 'idle' | 'pending' | 'fulfilled' | 'rejected'
    saving: 'idle', // 'idle' | 'pending' | 'fulfilled' | 'rejected'
    error: null,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST THUNKS
//
//  Wired into the existing presence slice so no new top-level
//  redux key is added. Sub-state lives at
//  `state.presence.workLocationRequests`.
// ═══════════════════════════════════════════════════════════════════════════

const rejectWlrWith = (err) => ({
  code: err.presenceCode || 'WORK_LOCATION_REQUEST_FAILED',
  message: err.message || 'WFH request failed',
});

export const submitWorkLocationRequest = createAsyncThunk(
  'presence/submitWorkLocationRequest',
  async (payload = {}, { rejectWithValue }) => {
    try {
      const result = await workLocationRequestService.submit(payload);
      return result?.data ?? result ?? null;
    } catch (err) {
      return rejectWithValue(rejectWlrWith(err));
    }
  },
);

export const fetchMyWorkLocationRequests = createAsyncThunk(
  'presence/fetchMyWorkLocationRequests',
  async (_arg, { rejectWithValue }) => {
    try {
      const result = await workLocationRequestService.mine();
      return result?.data ?? result ?? { requests: [] };
    } catch (err) {
      return rejectWithValue(rejectWlrWith(err));
    }
  },
);

export const cancelMyWorkLocationRequest = createAsyncThunk(
  'presence/cancelMyWorkLocationRequest',
  async (requestId, { rejectWithValue }) => {
    try {
      const result = await workLocationRequestService.cancel(requestId);
      return result?.data ?? result ?? null;
    } catch (err) {
      return rejectWithValue(rejectWlrWith(err));
    }
  },
);

export const fetchWorkLocationReviewQueue = createAsyncThunk(
  'presence/fetchWorkLocationReviewQueue',
  async (_arg, { rejectWithValue }) => {
    try {
      const result = await workLocationRequestService.pending();
      return result?.data?.requests ?? result?.requests ?? [];
    } catch (err) {
      return rejectWithValue(rejectWlrWith(err));
    }
  },
);

export const decideWorkLocationRequest = createAsyncThunk(
  'presence/decideWorkLocationRequest',
  async ({ requestId, action, decisionNote } = {}, { rejectWithValue }) => {
    try {
      if (action === 'approve') {
        const result = await workLocationRequestService.approve(
          requestId,
          decisionNote,
        );
        return result?.data ?? result ?? null;
      }
      if (action === 'reject') {
        const result = await workLocationRequestService.reject(
          requestId,
          decisionNote,
        );
        return result?.data ?? result ?? null;
      }
      throw new Error(`Unknown action: ${action}`);
    } catch (err) {
      return rejectWithValue(rejectWlrWith(err));
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.7 — TENANT ADMIN CONFIG THUNKS
//
//  The admin page reads the snapshot, lets the operator edit a draft,
//  and on save sends ONLY the keys whose draft differs from the
//  snapshot. The slice is therefore thin: it does load + save.
//
//  WHY A SEPARATE SUB-STATE INSTEAD OF RE-USING `current`
//    `current` is the user's OWN presence snapshot (presence / status
//    message / work location / live source). The admin config is
//    TENANT-level policy. Conflating them would let a non-admin
//    page accidentally see the company policy field, and would make
//    the audit log noisy.
//
//  WHY NO `dirty` FLAG IN THE SLICE
//    Per-field dirty lives in the page component (Phase 36 paid for
//    the page-wide dirty bug — see docs/PHASE_36.md §4.4 and the
//    PresenceSettingsPage implementation in 37.7). A slice-level
//    `dirty` boolean is a footgun: it would re-fire on every render
//    where a per-field draft happens to differ.
// ═══════════════════════════════════════════════════════════════════════════

const rejectConfigWith = (err) => ({
  code: err.presenceCode || 'PRESENCE_CONFIG_FAILED',
  message: err.message || 'Presence config request failed',
});

export const loadPresenceConfig = createAsyncThunk(
  'presence/loadConfig',
  async (_, { rejectWithValue }) => {
    try {
      const result = await getTenantConfig();
      return result || null;
    } catch (err) {
      return rejectWithValue(rejectConfigWith(err));
    }
  },
);

export const savePresenceConfig = createAsyncThunk(
  'presence/saveConfig',
  async (patch = {}, { rejectWithValue }) => {
    try {
      // The page constructs the patch — it MUST be a plain object with
      // ONLY whitelisted keys. The service is a thin pass-through; the
      // backend's `PRESENCE_UPDATABLE_FIELDS` whitelist is the authority.
      // We do NOT add a defensive strip here because stripping silently
      // would mask a frontend bug that ships `companyId` / `userId`.
      const result = await updateTenantConfig(patch);
      return result || null;
    } catch (err) {
      return rejectWithValue(rejectConfigWith(err));
    }
  },
);

const presenceSlice = createSlice({
  name: 'presence',
  initialState,
  reducers: {
    clearError(state) {
      state.error = null;
    },
    // ─────────────────────────────────────────────────────────────────
    //  PHASE 37.4 — REALTIME TICKS
    //
    //  `presenceTicked` is the per-self reducer invoked by the
    //  presenceRuntime's `presence:changed` listener when the
    //  envelope is the signed-in user's own row. The reducer is a
    //  no-op if the value is unchanged (idempotent), so a noisy
    //  feed cannot cause a re-render storm.
    //
    //  The envelope carries: {schemaVersion, companyId, userId,
    //  presence, presenceSource, occurredAt, source}. We update
    //  `current` only — no other state changes.
    // ─────────────────────────────────────────────────────────────────
    presenceTicked(state, action) {
      const env = action.payload;
      if (!env || env.schemaVersion !== 1) return;
      const next = env.presence;
      // Idempotent: same value → no work.
      if (state.current && state.current.presence === next) return;
      state.current = {
        ...(state.current || EMPTY_PRESENCE),
        presence: next,
        presenceSource: env.presenceSource || 'none',
        // `lastLiveAt` is the user-facing last-seen signal that
        // 37.1's display components already read. The envelope's
        // `occurredAt` is the authoritative server timestamp.
        lastLiveAt: env.occurredAt || state.current?.lastLiveAt || null,
        // Keep the reducer pure: the resolver's source is informational.
        lastLiveSource: env.source || 'resolver',
      };
    },
    // ─────────────────────────────────────────────────────────────────
    //  `presenceInvalidateTeam` — the runtime triggers a debounced
    //  re-dispatch of `fetchTeamAvailability` on same-company
    //  envelopes. The reducer bumps a counter so any team-page
    //  subscriber (memo, useEffect) can react. The thunk itself is
    //  fired from the runtime (which has the store reference).
    // ─────────────────────────────────────────────────────────────────
    presenceInvalidateTeam(state) {
      state.teamBumpedAt = new Date().toISOString();
    },
    // Phase 37.5 — when a presence:invalidated envelope arrives
    // for the signed-in user, drop the cached work-location
    // request rows so the next list fetch re-reads from the
    // server. The server is authoritative.
    presenceWlrInvalidateForUser(state) {
      state.workLocationRequests.myRequests = [];
      state.workLocationRequests.byId = {};
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
      })
      // ── Phase 37.5 — work-location request extra reducers ──
      .addCase(submitWorkLocationRequest.pending, (state) => {
        state.workLocationRequests.submitting = 'pending';
        state.workLocationRequests.error = null;
      })
      .addCase(submitWorkLocationRequest.fulfilled, (state, action) => {
        state.workLocationRequests.submitting = 'fulfilled';
        const row = action.payload;
        if (row && row.id) {
          state.workLocationRequests.byId[row.id] = row;
          state.workLocationRequests.myRequests = [
            row,
            ...state.workLocationRequests.myRequests.filter(
              (r) => r.id !== row.id,
            ),
          ];
        }
      })
      .addCase(submitWorkLocationRequest.rejected, (state, action) => {
        state.workLocationRequests.submitting = 'rejected';
        state.workLocationRequests.error = action.payload || {
          code: 'WORK_LOCATION_REQUEST_FAILED',
          message: 'Could not submit WFH request',
        };
      })
      .addCase(fetchMyWorkLocationRequests.pending, (state) => {
        state.workLocationRequests.loading = 'pending';
        state.workLocationRequests.error = null;
      })
      .addCase(fetchMyWorkLocationRequests.fulfilled, (state, action) => {
        state.workLocationRequests.loading = 'fulfilled';
        const list = action.payload?.requests || [];
        state.workLocationRequests.myRequests = list;
        state.workLocationRequests.byId = Object.fromEntries(
          list.map((r) => [r.id, r]),
        );
      })
      .addCase(fetchMyWorkLocationRequests.rejected, (state, action) => {
        state.workLocationRequests.loading = 'rejected';
        state.workLocationRequests.error = action.payload || {
          code: 'WORK_LOCATION_REQUEST_LOAD_FAILED',
          message: 'Could not load WFH requests',
        };
      })
      .addCase(cancelMyWorkLocationRequest.fulfilled, (state, action) => {
        const row = action.payload;
        if (row && row.id) {
          state.workLocationRequests.byId[row.id] = row;
          state.workLocationRequests.myRequests = state.workLocationRequests.myRequests.map(
            (r) => (r.id === row.id ? row : r),
          );
        }
      })
      .addCase(fetchWorkLocationReviewQueue.pending, (state) => {
        state.workLocationRequests.loadingQueue = 'pending';
        state.workLocationRequests.error = null;
      })
      .addCase(fetchWorkLocationReviewQueue.fulfilled, (state, action) => {
        state.workLocationRequests.loadingQueue = 'fulfilled';
        state.workLocationRequests.reviewQueue = action.payload || [];
      })
      .addCase(fetchWorkLocationReviewQueue.rejected, (state, action) => {
        state.workLocationRequests.loadingQueue = 'rejected';
        state.workLocationRequests.error = action.payload || {
          code: 'WORK_LOCATION_REVIEW_LOAD_FAILED',
          message: 'Could not load review queue',
        };
      })
      .addCase(decideWorkLocationRequest.pending, (state) => {
        state.workLocationRequests.decisionPending = 'pending';
        state.workLocationRequests.error = null;
      })
      .addCase(decideWorkLocationRequest.fulfilled, (state, action) => {
        state.workLocationRequests.decisionPending = 'fulfilled';
        const row = action.payload;
        if (row && row.id) {
          state.workLocationRequests.byId[row.id] = row;
          state.workLocationRequests.lastDecidedId = row.id;
          state.workLocationRequests.reviewQueue = state.workLocationRequests.reviewQueue.filter(
            (r) => r.id !== row.id,
          );
        }
      })
      .addCase(decideWorkLocationRequest.rejected, (state, action) => {
        state.workLocationRequests.decisionPending = 'rejected';
        state.workLocationRequests.error = action.payload || {
          code: 'WORK_LOCATION_REQUEST_DECIDE_FAILED',
          message: 'Could not decide WFH request',
        };
      })
      // ── Phase 37.7 — tenant config thunks ──
      .addCase(loadPresenceConfig.pending, (state) => {
        state.config.loading = 'pending';
        state.config.error = null;
      })
      .addCase(loadPresenceConfig.fulfilled, (state, action) => {
        state.config.loading = 'fulfilled';
        state.config.data = action.payload || null;
        state.config.error = null;
      })
      .addCase(loadPresenceConfig.rejected, (state, action) => {
        state.config.loading = 'rejected';
        // A failed load is NOT a silent default. The page must show
        // an error and stay on a "couldn't load" state, NOT a
        // permissive defaults view.
        state.config.data = null;
        state.config.error = action.payload || {
          code: 'PRESENCE_CONFIG_LOAD_FAILED',
          message: 'Could not load presence configuration.',
        };
      })
      .addCase(savePresenceConfig.pending, (state) => {
        state.config.saving = 'pending';
        state.config.error = null;
      })
      .addCase(savePresenceConfig.fulfilled, (state, action) => {
        state.config.saving = 'fulfilled';
        // The backend returns the canonicalized snapshot; replace
        // whatever the page had locally. The page will then re-derive
        // the dirty map from this fresh snapshot.
        if (action.payload) state.config.data = action.payload;
        state.config.error = null;
      })
      .addCase(savePresenceConfig.rejected, (state, action) => {
        state.config.saving = 'rejected';
        // Preserve the last good snapshot — failed save does not wipe
        // the form. The page reads `config.error` to show the message.
        state.config.error = action.payload || {
          code: 'PRESENCE_CONFIG_SAVE_FAILED',
          message: 'Could not save presence configuration.',
        };
      });
  },
});

export const { clearError, presenceTicked, presenceInvalidateTeam, presenceWlrInvalidateForUser } = presenceSlice.actions;
export default presenceSlice.reducer;