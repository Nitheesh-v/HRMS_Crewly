import api from './api.js';

const unwrap = (response) =>
  response?.data?.data ??
  response?.data ??
  response ??
  {};

const requisitionService = {
  list: async (params = {}) => {
    const response = await api.get('/recruitment/requisitions', { params });

    if (Array.isArray(response)) {
      return { requisitions: response, meta: {} };
    }

    return {
      requisitions: Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response?.requisitions)
          ? response.requisitions
          : [],
      meta: response?.meta || {},
      summary: response?.meta?.summary || response?.summary || {},
    };
  },

  options: () =>
    api
      .get('/recruitment/requisitions/options')
      .then(unwrap),

  getById: (id) =>
    api
      .get(`/recruitment/requisitions/${id}`)
      .then(unwrap),

  create: (data) =>
    api
      .post('/recruitment/requisitions', data)
      .then(unwrap),

  update: (id, data) =>
    api
      .patch(`/recruitment/requisitions/${id}`, data)
      .then(unwrap),

  submit: (id, comment = '') =>
    api
      .post(`/recruitment/requisitions/${id}/submit`, { comment })
      .then(unwrap),

  approve: (id, comment = '') =>
    api
      .post(`/recruitment/requisitions/${id}/approve`, { comment })
      .then(unwrap),

  reject: (id, comment) =>
    api
      .post(`/recruitment/requisitions/${id}/reject`, { comment })
      .then(unwrap),

  sendBack: (id, comment) =>
    api
      .post(`/recruitment/requisitions/${id}/send-back`, { comment })
      .then(unwrap),

  createJob: (id, data = {}) =>
    api
      .post(`/recruitment/requisitions/${id}/create-job`, data)
      .then(unwrap),
};

export default requisitionService;
