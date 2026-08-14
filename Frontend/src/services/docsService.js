// ============================================================
// 📁 docsService — Phase 14 (employee documents + requests)
// 🩹 hardened: uploads ALWAYS go out as real multipart,
//    no matter what the shared axios instance defaults to.
// ============================================================
import * as apiNS from './api.js';
const api = apiNS.default || apiNS.api || apiNS;

const unwrap = (x) => x?.data ?? x;
export const arr = (x) => {
  const d = unwrap(x);
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.documents)) return d.documents;
  return [];
};

// 🩹 FormData must travel as multipart/form-data — never JSON
const postForm = (url, fd) =>
  api.post(url, fd, { headers: { 'Content-Type': 'multipart/form-data' } });

/* ── shared ── */
export const getDocCategories = async () => arr(await api.get('/documents/meta/categories'));
export const getMyDocuments = async () => arr(await api.get('/documents/my'));
export const uploadMyDocument = (formData) => postForm('/documents', formData);
export const deleteDocument = (id) => api.delete(`/documents/${id}`);

/* ── employee: requests ── */
export const getMyDocRequests = async () => arr(await api.get('/documents/requests/my'));
export const fulfillDocRequest = (id, formData) => postForm(`/documents/requests/${id}/fulfill`, formData);

/* ── HR / Admin: cabinet + requests ── */
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
export const getEmployeeCabinet = async (userId) => unwrap(await api.get(`/documents/employee/${userId}`));
export const hrUploadDocument = (userId, formData) => postForm(`/documents/for/${userId}`, formData);
export const createDocRequest = (payload) => api.post('/documents/requests', payload);
export const cancelDocRequest = (id) => api.patch(`/documents/requests/${id}/cancel`);