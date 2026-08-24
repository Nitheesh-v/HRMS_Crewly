import api from './api.js';

const unwrap = (response) =>
  response?.data?.data ??
  response?.data ??
  response ??
  {};

const paginated = (response) => ({
  interviews: Array.isArray(response?.data?.data)
    ? response.data.data
    : Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : [],
  meta: response?.data?.meta ?? response?.meta ?? {},
});

const interviewService = {
  options: () => api.get('/recruitment/interviews/options').then(unwrap),

  eligibleInterviewers: () =>
    api.get('/recruitment/interviews/eligible-interviewers').then(unwrap),

  list: (params = {}) =>
    api.get('/recruitment/interviews', { params }).then(paginated),

  myInterviews: (params = {}) =>
    api
      .get('/recruitment/interviews/my-interviews', { params })
      .then(paginated),

  detail: (interviewId) =>
    api.get(`/recruitment/interviews/${interviewId}`).then(unwrap),

  candidateInterviews: (candidateRef) =>
    api
      .get(`/recruitment/candidates/${candidateRef}/interviews`)
      .then(unwrap),

  schedule: (data) =>
    api.post('/recruitment/interviews', data).then(unwrap),

  reschedule: (interviewId, data) =>
    api
      .patch(`/recruitment/interviews/${interviewId}/reschedule`, data)
      .then(unwrap),

  cancel: (interviewId, reason) =>
    api
      .post(`/recruitment/interviews/${interviewId}/cancel`, { reason })
      .then(unwrap),

  updateStatus: (interviewId, status, reason = '') =>
    api
      .patch(`/recruitment/interviews/${interviewId}/status`, {
        status,
        reason,
      })
      .then(unwrap),
};

export default interviewService;
