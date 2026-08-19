import { configureStore } from '@reduxjs/toolkit';
import authReducer from "../redux/slices/AuthSlices.js"
import permissionReducer from './slices/PermissionSlices.js';


// Central Redux store — every module (employees, attendance...)
// adds its slice here in later phases.
const store = configureStore({
  reducer: {
    auth: authReducer,
    permissions: permissionReducer,
    // employees: employeesReducer,   // Phase 3
    // attendance: attendanceReducer, // Phase 4
  },
});

export default store;