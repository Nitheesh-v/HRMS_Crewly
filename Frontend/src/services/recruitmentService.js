import api from './api';

const recruitmentService = {
  jobs: () => api.get('/recruitment/jobs'),
  createJob: (data) => api.post('/recruitment/jobs', data),
  updateJob: (id, data) => api.patch(`/recruitment/jobs/${id}`, data),

  candidates: (jobId) => api.get('/recruitment/candidates', { params: jobId ? { job: jobId } : {} }),
  addCandidate: (data) => api.post('/recruitment/candidates', data),
  updateStage: (id, stage) => api.patch(`/recruitment/candidates/${id}/stage`, { stage }),
  updateOffer: (id, data) => api.patch(`/recruitment/candidates/${id}/offer`, data),
  convert: (id) => api.post(`/recruitment/candidates/${id}/convert`),
};

export default recruitmentService;