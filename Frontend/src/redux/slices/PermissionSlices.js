import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import permissionService from "../../services/permissionService.js";

const PLATFORM_ROLES = [
  "SUPER_ADMIN",
  "PLATFORM_ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN",
];

const emptyPermissionData = {
  role: null,
  permissions: [],
  deniedPermissions: [],
};

export const fetchMyPermissions = createAsyncThunk(
  "permissions/fetchMine",

  async (_, { getState, rejectWithValue }) => {
    /*
     * 35.4 — THE PERMISSION PAYLOAD THE APP NEVER ASKED FOR.
     *
     * This thunk used to bail out with an EMPTY permission set whenever
     * `state.auth.token` was falsy. Since the 33.14 cookie migration a
     * CUSTOMER session has `token === null` BY DESIGN (see AuthSlices /
     * useAuth: "a null token is what keeps api.js from attaching a header at
     * all"), so for every company user — including a Company Admin whose role
     * carries all 227 permissions — the API was never called and the app
     * believed the person had NO permissions whatsoever. Every gated page
     * answered "Your account cannot open this page yet", while the Roles
     * screen (the one screen with no guard) happily rendered the full matrix:
     * "all are selected, but not coming inside".
     *
     * The cookie IS the session and axios sends it (`withCredentials: true`);
     * a missing/expired cookie comes back as a 401 that this thunk already
     * reports through its fail-closed path. So the only thing worth skipping
     * the request for is a missing USER.
     */
    const { user } = getState().auth;

    if (!user) {
      return {
        ...emptyPermissionData,
        loadedUserId: null,
      };
    }

    // Platform roles use the separate provider RBAC.
    if (PLATFORM_ROLES.includes(user.role)) {
      return {
        ...emptyPermissionData,
        loadedUserId: user.id || user._id,
      };
    }

    try {
      const result = await permissionService.myPermissions();

      return {
        role: result?.role || null,

        permissions: Array.isArray(result?.permissions)
          ? result.permissions
          : [],

        deniedPermissions: Array.isArray(result?.deniedPermissions)
          ? result.deniedPermissions
          : [],

        loadedUserId: user.id || user._id,
      };
    } catch (error) {
      return rejectWithValue(
        error?.response?.data?.message ||
          error?.message ||
          "Could not load permissions",
      );
    }
  },

  {
    // Prevent duplicate requests when several components
    // call usePermission during the same render.
    condition: (_, { getState }) => {
      const state = getState();

      const { user } = state.auth;

      const permissions = state.permissions;

      /*
       * 35.4 — same trap as the thunk body: a customer has no JS-visible
       * token, and "no token" used to mean "let it through" on every single
       * dispatch. Keying the dedupe on the USER (which is what the payload is
       * about) is both correct and quieter.
       */
      if (!user) {
        return true;
      }

      const userId = user.id || user._id;

      if (permissions.loading) {
        return false;
      }

      if (permissions.loadedUserId === userId && permissions.loaded) {
        return false;
      }

      return true;
    },
  },
);

const initialState = {
  ...emptyPermissionData,

  loaded: false,
  loading: false,
  loadedUserId: null,
  error: "",
};

const permissionSlice = createSlice({
  name: "permissions",
  initialState,

  reducers: {
    clearPermissions: (state) => {
      state.role = null;
      state.permissions = [];
      state.deniedPermissions = [];
      state.loaded = false;
      state.loading = false;
      state.loadedUserId = null;
      state.error = "";
    },

    invalidatePermissions: (state) => {
      // Existing values stay until refresh completes,
      // but loaded=false permits a fresh request.
      state.loaded = false;
      state.error = "";
    },
  },

  extraReducers: (builder) => {
    builder
      .addCase(fetchMyPermissions.pending, (state) => {
        state.loading = true;
        state.error = "";
      })

      .addCase(fetchMyPermissions.fulfilled, (state, action) => {
        state.role = action.payload.role;

        state.permissions = action.payload.permissions;

        state.deniedPermissions = action.payload.deniedPermissions;

        state.loadedUserId = action.payload.loadedUserId;

        state.loaded = true;
        state.loading = false;
        state.error = "";
      })

      .addCase(fetchMyPermissions.rejected, (state, action) => {
        // Fail closed when permission loading fails.
        state.role = null;
        state.permissions = [];
        state.deniedPermissions = [];
        state.loaded = true;
        state.loading = false;

        state.error = action.payload || "Could not load permissions";
      });
  },
});

export const { clearPermissions, invalidatePermissions } =
  permissionSlice.actions;

export const selectPermissionState = (state) => state.permissions;

export default permissionSlice.reducer;
