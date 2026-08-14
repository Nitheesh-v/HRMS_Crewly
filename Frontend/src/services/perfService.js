// 🎯 perfService — Performance Management
import * as apiNS from './api.js';
const api = apiNS.default || apiNS.api || apiNS;

const unwrap = (x) => x?.data ?? x;
const arr = (x) => {
  const d = unwrap(x);
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.cycles)) return d.cycles;
  if (Array.isArray(d?.appraisals)) return d.appraisals;
  return [];
};

export const getCycles = async () => unwrap(await api.get('/perf/cycles'));
export const createCycle = (payload) => api.post('/perf/cycles', payload);
export const transitionCycle = (id, to) => api.patch(`/perf/cycles/${id}/status`, { to });
export const enrollMissing = (id) => api.post(`/perf/cycles/${id}/enroll`);
export const getMyAppraisal = async (cycleId) => unwrap(await api.get(`/perf/cycles/${cycleId}/my`));
export const getTeamBoard = async (cycleId) => unwrap(await api.get(`/perf/cycles/${cycleId}/team`));
export const saveGoals = (appraisalId, goals) => api.put(`/perf/appraisals/${appraisalId}/goals`, { goals });
export const updateProgress = (appraisalId, goalId, progress, note) =>
  api.patch(`/perf/appraisals/${appraisalId}/goals/${goalId}/progress`, { progress, note });
export const submitSelfReview = (appraisalId, payload) => api.post(`/perf/appraisals/${appraisalId}/self-review`, payload);
export const submitReview = (appraisalId, payload) => api.post(`/perf/appraisals/${appraisalId}/review`, payload);
export const getHistory = async (userId) => arr(await api.get('/perf/history', { params: userId ? { userId } : {} }));