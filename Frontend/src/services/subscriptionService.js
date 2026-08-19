import api from './api.js';

const unwrap = (r) =>
  r?.data?.data ??
  r?.data ??
  r ??
  {};

const get = (url, params) =>
  api
    .get(url, { params })
    .then(unwrap);

const post = (url, body) =>
  api
    .post(url, body)
    .then(unwrap);

const patch = (url, body) =>
  api
    .patch(url, body)
    .then(unwrap);

const subscriptionService = {
  current: () =>
    get('/subscription/current'),

  usage: () =>
    get('/subscription/usage'),

  features: () =>
    get('/subscription/features'),

  history: () =>
    get('/subscription/history'),

  plans: () =>
    get('/subscription/plans'),

  quote: (body) =>
    post('/subscription/quote', body),

  downgrade: (body) =>
    post('/subscription/downgrade', body),

  cancel: (reason) =>
    post('/subscription/cancel', {
      reason,
    }),

  restore: (reason) =>
    post('/subscription/restore', {
      reason,
    }),

  setAutoRenew: (enabled) =>
    patch('/subscription/auto-renew', {
      enabled,
    }),

  limit: (resource) =>
    get(
      `/subscription/limits/${resource}`
    ),

  feature: (feature) =>
    get(
      `/subscription/features/${feature}`
    ),

  invoices: () =>
    get('/billing/invoices'),

  payments: () =>
    get('/billing/payments'),
};

export default subscriptionService;
export { subscriptionService };