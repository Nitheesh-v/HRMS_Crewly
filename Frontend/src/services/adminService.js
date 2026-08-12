// ============================================================
// 👑 ADMIN SERVICE — super admin platform APIs (/api/admin-api/*)
// ============================================================
import * as apiNS from './api';

const api = apiNS.default || apiNS.api || apiNS;

const adminService = {
  overview: () => api.get('/admin-api/overview'),
  companies: () => api.get('/admin-api/companies'),
  revenue: () => api.get('/admin-api/revenue'),
  setCompanyStatus: (id, status) => api.patch(`/admin-api/companies/${id}/status`, { status }),
};

export default adminService;
export { adminService };