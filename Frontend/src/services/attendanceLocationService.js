import api from './api.js';

// Phase 31.3 — Attendance Locations.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser.
const envelope = (promise) => promise.then((response) => response?.data || {});

const attendanceLocationService = {
  list: () => envelope(api.get('/attendance/locations')),

  eligible: () => envelope(api.get('/attendance/locations/eligible')),

  get: (locationId) => envelope(api.get(`/attendance/locations/${locationId}`)),

  create: (payload) => envelope(api.post('/attendance/locations', payload)),

  update: (locationId, payload) => envelope(api.put(`/attendance/locations/${locationId}`, payload)),

  activate: (locationId) => envelope(api.post(`/attendance/locations/${locationId}/activate`)),

  deactivate: (locationId) => envelope(api.post(`/attendance/locations/${locationId}/deactivate`)),
};

export default attendanceLocationService;
