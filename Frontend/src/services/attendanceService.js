import api from './api.js';

const attendanceService = {
  punchIn: () => api.post('/attendance/punch-in'),
  punchOut: () => api.post('/attendance/punch-out'),
  today: () => api.get('/attendance/today'),
  my: (month) => api.get(`/attendance/my?month=${month}`),
  company: (date) => api.get(`/attendance/company${date ? `?date=${date}` : ''}`),
  report: (month, department) =>
    api.get(`/attendance/report?month=${month}${department ? `&department=${department}` : ''}`),
};

export default attendanceService;