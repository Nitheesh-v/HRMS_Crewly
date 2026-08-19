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
    const { user, token } = getState().auth;

    if (!user || !token) {
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

      const { user, token } = state.auth;

      const permissions = state.permissions;

      if (!user || !token) {
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
