// ============================================================
// 🧬 lifecycleService — Phase 15
// ============================================================
import * as apiNS from './api.js';
const api = apiNS.default || apiNS.api || apiNS;

const unwrap = (x) => x?.data ?? x;
const arr = (x) => {
  const d = unwrap(x);
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  return [];
};

export const getMyJourney = async () => unwrap(await api.get('/lifecycle/my'));
export const getOverview = async () => unwrap(await api.get('/lifecycle/overview'));
export const getCompanyLifecycles = async (stage) =>
  arr(await api.get('/lifecycle/company', { params: stage ? { stage } : {} }));
export const getUserJourney = async (userId) => unwrap(await api.get(`/lifecycle/user/${userId}`));
export const setStage = (userId, payload) => api.post(`/lifecycle/user/${userId}/stage`, payload);
export const promoteUser = (userId, payload) => api.post(`/lifecycle/user/${userId}/promote`, payload);
export const transferUser = (userId, payload) => api.post(`/lifecycle/user/${userId}/transfer`, payload);

export const getDepartments = async () => {
  try {
    return arr(await api.get('/departments'));
  } catch {
    return [];
  }
};

export const getEmployees = async () => {
  try {
    return arr(await api.get('/users'));
  } catch {
    try {
      return arr(await api.get('/employees'));
    } catch {
      return [];
    }
  }
};