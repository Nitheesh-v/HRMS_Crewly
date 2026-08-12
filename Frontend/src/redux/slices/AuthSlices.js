import { createSlice } from '@reduxjs/toolkit';

// Restore session from localStorage when app starts
const getStoredUser = () => {
  try {
    const storedUser = localStorage.getItem('infolexus_user');
    const token = localStorage.getItem('infolexus_token');
    return storedUser && token ? JSON.parse(storedUser) : null;
  } catch {
    localStorage.removeItem('infolexus_user');
    localStorage.removeItem('infolexus_token');
    return null;
  }
};

const initialState = {
  user: getStoredUser(), // { id, name, email, role, companyId } after login
  token: localStorage.getItem('infolexus_token') || null,
};

// role ∈ SUPER_ADMIN | COMPANY_ADMIN | HR_MANAGER | MANAGER | TEAM_LEAD | EMPLOYEE

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    // Called after successful login — saves user + JWT
    setCredentials: (state, action) => {
      const { user, token } = action.payload;
      state.user = user;
      state.token = token;
      localStorage.setItem('infolexus_token', token);
      localStorage.setItem('infolexus_user', JSON.stringify(user));
    },

    // Called on logout — clears everything
    logout: (state) => {
      state.user = null;
      state.token = null;
      localStorage.removeItem('infolexus_token');
      localStorage.removeItem('infolexus_user');
    },
  },
});

export const { setCredentials, logout } = authSlice.actions;
export default authSlice.reducer;