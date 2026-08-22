import api from './api.js';

const unwrap = (response) =>
  response?.data?.data ??
  response?.data ??
  response ??
  {};

const candidateService = {
  list: async (params = {}) => {
    const response = await api.get('/recruitment/candidates/inbox', {
      params,
    });
    const data = unwrap(response);

    return {
      candidates: Array.isArray(data) ? data : [],
      meta: response?.meta || {},
    };
  },

  detail: (candidateRef) =>
    api
      .get(`/recruitment/candidates/${candidateRef}/detail`)
      .then(unwrap),

  resume: (candidateRef) =>
    api
      .get(`/recruitment/candidates/${candidateRef}/resume`, {
        responseType: 'blob',
      })
      .then(unwrap),

  parsedResume: (candidateRef) =>
    api
      .get(`/recruitment/candidates/${candidateRef}/resume/parsed`)
      .then(unwrap),

  reprocessResume: (candidateRef) =>
    api
      .post(`/recruitment/candidates/${candidateRef}/resume/reprocess`, {})
      .then(unwrap),

  atsResult: (candidateRef) =>
    api
      .get(`/recruitment/candidates/${candidateRef}/ats-result`)
      .then(unwrap),

  reprocessATS: (candidateRef) =>
    api
      .post(`/recruitment/candidates/${candidateRef}/ats-reprocess`, {})
      .then(unwrap),
};

export default candidateService;
