import api from './api';

const billingService = {
  plans: () => api.get('/billing/plans'),
  subscription: () => api.get('/billing/subscription'),
  checkout: (data) => api.post('/billing/checkout', data),
  verify: (data) => api.post('/billing/verify', data),
  payments: () => api.get('/billing/payments'),
};

export default billingService;