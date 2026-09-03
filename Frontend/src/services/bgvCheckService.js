// Phase 30.1 — BGV Verifier Workbench API (checks layer).
// The 27.15 case family stays in bgvService.js; no overlap.
import api from './api.js';

const unwrap = (response) => {
  if (response == null) return {};
  if (Array.isArray(response)) return response;
  if (response?.data?.data !== undefined) return response.data.data;
  if (
    response?.data !== undefined &&
    (response?.success !== undefined || response?.meta !== undefined)
  ) {
    return response.data;
  }
  return response;
};

const metaOf = (response) => response?.meta || response?.data?.meta || {};

const bgvCheckService = {
  list: async (params = {}) => {
    const response = await api.get('/bgv/checks', { params });
    const data = unwrap(response);
    return { checks: Array.isArray(data) ? data : data?.checks || [], meta: metaOf(response) };
  },
  mine: async (params = {}) => {
    const response = await api.get('/bgv/checks/mine', { params });
    const data = unwrap(response);
    return { checks: Array.isArray(data) ? data : data?.checks || [], meta: metaOf(response) };
  },
  stats: async () => unwrap(await api.get('/bgv/checks/stats')),
  detail: async (checkId) => unwrap(await api.get(`/bgv/checks/${checkId}`)),
  assign: async (checkId, verifierId) =>
    unwrap(await api.post(`/bgv/checks/${checkId}/assign`, { verifierId })),
  updateStatus: async (checkId, payload) =>
    unwrap(await api.post(`/bgv/checks/${checkId}/status`, payload)),
  extendSla: async (checkId, payload) =>
    unwrap(await api.post(`/bgv/checks/${checkId}/extend-sla`, payload)),
  reopen: async (checkId, reason) =>
    unwrap(await api.post(`/bgv/checks/${checkId}/reopen`, { reason })),
  addEvidence: async (checkId, formData) =>
    unwrap(
      await api.post(`/bgv/checks/${checkId}/evidence`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    ),
  downloadEvidence: async (checkId, evidenceId, filename) => {
    const blob = await api.get(`/bgv/checks/${checkId}/evidence/${evidenceId}`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(blob instanceof Blob ? blob : blob?.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'evidence';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
  seedCase: async (caseId) => unwrap(await api.post(`/bgv/cases/${caseId}/seed-checks`)),
};

export default bgvCheckService;
