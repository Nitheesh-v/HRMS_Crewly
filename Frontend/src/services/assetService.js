// 🖥 assetService
import * as apiNS from './api.js';
const api = apiNS.default || apiNS.api || apiNS;

const unwrap = (x) => x?.data ?? x;
const arr = (x) => {
  const d = unwrap(x);
  return Array.isArray(d) ? d : [];
};

export const getMyAssets = async () => arr(await api.get('/assets/my'));
export const getAllAssets = async (status) => arr(await api.get('/assets', { params: status ? { status } : {} }));
export const createAsset = (payload) => api.post('/assets', payload);
export const assignAsset = (id, payload) => api.post(`/assets/${id}/assign`, payload);
export const returnAsset = (id, note) => api.post(`/assets/${id}/return`, { note });
export const deleteAsset = (id) => api.delete(`/assets/${id}`);