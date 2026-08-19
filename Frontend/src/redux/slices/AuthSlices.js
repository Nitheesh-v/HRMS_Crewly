import {
  createSlice,
} from '@reduxjs/toolkit';

const getStoredUser = () => {
  try {
    const storedUser =
      localStorage.getItem(
        'infolexus_user',
      );

    const token =
      localStorage.getItem(
        'infolexus_token',
      );

    return storedUser && token
      ? JSON.parse(storedUser)
      : null;
  } catch {
    localStorage.removeItem(
      'infolexus_user',
    );

    localStorage.removeItem(
      'infolexus_token',
    );

    return null;
  }
};

const initialState = {
  user: getStoredUser(),

  token:
    localStorage.getItem(
      'infolexus_token',
    ) || null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,

  reducers: {
    setCredentials: (
      state,
      action,
    ) => {
      const {
        user,
        token,
      } = action.payload;

      state.user = user;
      state.token = token;

      localStorage.setItem(
        'infolexus_token',
        token,
      );

      localStorage.setItem(
        'infolexus_user',
        JSON.stringify(user),
      );
    },

    /*
     * Called by the Axios interceptor after
     * refresh-token rotation.
     */
    accessTokenRefreshed: (
      state,
      action,
    ) => {
      state.token = action.payload;

      localStorage.setItem(
        'infolexus_token',
        action.payload,
      );
    },

    logout: (state) => {
      state.user = null;
      state.token = null;

      localStorage.removeItem(
        'infolexus_token',
      );

      localStorage.removeItem(
        'infolexus_user',
      );
    },
  },
});

export const {
  setCredentials,
  accessTokenRefreshed,
  logout,
} = authSlice.actions;

export default authSlice.reducer;