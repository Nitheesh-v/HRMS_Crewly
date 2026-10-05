import { configureStore } from '@reduxjs/toolkit';
import authReducer from "../redux/slices/AuthSlices.js"
import permissionReducer from './slices/PermissionSlices.js';
import chatReducer from './slices/chatSlice.js';
import aiChatReducer from './slices/aiChatSlice.js';
import presenceReducer from './slices/presenceSlice.js';


// Central Redux store — every module (employees, attendance...)
// adds its slice here in later phases.
const store = configureStore({
  reducer: {
    auth: authReducer,
    permissions: permissionReducer,
    chat: chatReducer, // Phase 33.8 — Chat Hub
    aiChat: aiChatReducer, // Phase 36.3 — AI Assistant (session only)
    presence: presenceReducer, // Phase 37.1 — Presence foundation (self-service); 37.5 extends this slice with `workLocationRequests` sub-state.
    // employees: employeesReducer,   // Phase 3
    // attendance: attendanceReducer, // Phase 4
  },
});

export default store;
