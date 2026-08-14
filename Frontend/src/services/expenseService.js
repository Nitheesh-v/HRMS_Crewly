// 💸 expenseService
import * as apiNS from './api.js';
const api = apiNS.default || apiNS.api || apiNS;

const unwrap = (x) => x?.data ?? x;
const arr = (x) => {
  const d = unwrap(x);
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.expenses)) return d.expenses;
  return [];
};

export const submitExpense = (formData) =>
  api.post('/expenses', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
export const getMyExpenses = async () => arr(await api.get('/expenses/my'));
export const getApprovals = async () => arr(await api.get('/expenses/approvals'));
export const managerDecide = (id, action, note) => api.post(`/expenses/${id}/manager-decide`, { action, note });
export const financeDecide = (id, action, note) => api.post(`/expenses/${id}/finance-decide`, { action, note });
export const markReimbursed = (id) => api.post(`/expenses/${id}/reimburse`);
export const cancelExpense = (id) => api.patch(`/expenses/${id}/cancel`);
export const getAllExpenses = async (status) =>
  unwrap(await api.get('/expenses/all', { params: status ? { status } : {} }));