import { configureStore } from '@reduxjs/toolkit';
import authReducer from "../redux/slices/AuthSlices.js"

// Central Redux store — every module (employees, attendance...)
// adds its slice here in later phases.
const store = configureStore({
  reducer: {
    auth: authReducer,
    // employees: employeesReducer,   // Phase 3
    // attendance: attendanceReducer, // Phase 4
  },
});

export default store;