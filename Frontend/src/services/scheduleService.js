import * as apiNS from './api.js';

const api = apiNS.default || apiNS.api || apiNS;
const unwrap = (r) => r?.data?.data ?? r?.data ?? r ?? {};

export const scheduleService = {
  // holidays
  listHolidays: (params) => api.get('/holidays', { params }).then(unwrap),
  upcoming: (days = 60) => api.get('/holidays/upcoming', { params: { days } }).then(unwrap),
  createHoliday: (payload) => api.post('/holidays', payload).then(unwrap),
  updateHoliday: (id, payload) => api.put(`/holidays/${id}`, payload).then(unwrap),
  deleteHoliday: (id) => api.delete(`/holidays/${id}`).then(unwrap),
  pick: (id) => api.post(`/holidays/${id}/pick`).then(unwrap),
  unpick: (id) => api.delete(`/holidays/${id}/pick`).then(unwrap),
  // schedules
  listSchedules: () => api.get('/schedules').then(unwrap),
  createSchedule: (payload) => api.post('/schedules', payload).then(unwrap),
  updateSchedule: (id, payload) => api.put(`/schedules/${id}`, payload).then(unwrap),
  deleteSchedule: (id) => api.delete(`/schedules/${id}`).then(unwrap),
  assignSchedule: (id, payload) => api.post(`/schedules/${id}/assign`, payload).then(unwrap),
  unassignSchedule: (id, payload) => api.post(`/schedules/${id}/unassign`, payload).then(unwrap),
  mySchedule: () => api.get('/schedules/my').then(unwrap),
  // shifts
  listShifts: () => api.get('/shifts').then(unwrap),
  createShift: (payload) => api.post('/shifts', payload).then(unwrap),
  updateShift: (id, payload) => api.put(`/shifts/${id}`, payload).then(unwrap),
  deleteShift: (id) => api.delete(`/shifts/${id}`).then(unwrap),
  assignShift: (id, payload) => api.post(`/shifts/${id}/assign`, payload).then(unwrap),
  shiftHistory: (userId) => api.get(`/shifts/history/${userId}`).then(unwrap),
  myShift: () => api.get('/shifts/my').then(unwrap),
  myRoster: () => api.get('/my-roster').then(unwrap),
  evaluate: (payload) => api.post('/shifts/evaluate', payload).then(unwrap),
  payrollInputs: (params) => api.get('/shifts/payroll-inputs', { params }).then(unwrap),
  // shared pickers
  getDepartments: () => api.get('/departments').then((r) => {
    const d = r?.data?.data?.departments || r?.data?.data?.items || r?.data?.data || r?.data || [];
    return { departments: Array.isArray(d) ? d : [] };
  }).catch(() => ({ departments: [] })),
};

export default scheduleService;