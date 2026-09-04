// ============================================================
//  PHASE 30.1.1 — BGV Ops Workbench API (SUPER ADMIN portal)
//
//  BGV verification is Crewly-team operated: every call here hits
//  /api/super-admin/bgv (platform session + bgv:read/verify/assign
//  permits). Tenant users get only bgvService.checksSummary().
// ============================================================

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

const BASE = '/super-admin/bgv';

const superAdminBgvService = {
  list: async (params = {}) => {
    const response = await api.get(`${BASE}/checks`, { params });
    const data = unwrap(response);
    return { checks: Array.isArray(data) ? data : data?.checks || [], meta: metaOf(response) };
  },
  mine: async (params = {}) => {
    const response = await api.get(`${BASE}/checks/mine`, { params });
    const data = unwrap(response);
    return { checks: Array.isArray(data) ? data : data?.checks || [], meta: metaOf(response) };
  },
  stats: async (params = {}) => unwrap(await api.get(`${BASE}/checks/stats`, { params })),
  verifiers: async () => unwrap(await api.get(`${BASE}/checks/verifiers`)),
  detail: async (checkId) => unwrap(await api.get(`${BASE}/checks/${checkId}`)),
  assign: async (checkId, verifierId) =>
    unwrap(await api.post(`${BASE}/checks/${checkId}/assign`, { verifierId })),
  updateStatus: async (checkId, payload) =>
    unwrap(await api.post(`${BASE}/checks/${checkId}/status`, payload)),
  extendSla: async (checkId, payload) =>
    unwrap(await api.post(`${BASE}/checks/${checkId}/extend-sla`, payload)),
  reopen: async (checkId, reason) =>
    unwrap(await api.post(`${BASE}/checks/${checkId}/reopen`, { reason })),
  addEvidence: async (checkId, formData) =>
    unwrap(
      await api.post(`${BASE}/checks/${checkId}/evidence`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    ),
  downloadEvidence: async (checkId, evidenceId, filename) => {
    const blob = await api.get(`${BASE}/checks/${checkId}/evidence/${evidenceId}`, {
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
  seedCase: async (caseId, companyId) =>
    unwrap(await api.post(`${BASE}/cases/${caseId}/seed-checks`, companyId ? { companyId } : {})),
};

export default superAdminBgvService;
