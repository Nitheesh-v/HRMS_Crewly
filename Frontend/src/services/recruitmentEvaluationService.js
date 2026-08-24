import api from './api.js';

const unwrap = (response) =>
  response?.data?.data ??
  response?.data ??
  response ??
  {};

const recruitmentEvaluationService = {
  scorecard: (interviewId) =>
    api.get(`/recruitment/interviews/${interviewId}/scorecard`).then(unwrap),

  myFeedback: (interviewId) =>
    api.get(`/recruitment/interviews/${interviewId}/my-feedback`).then(unwrap),

  saveMyFeedback: (interviewId, data) =>
    api.put(`/recruitment/interviews/${interviewId}/my-feedback`, data).then(unwrap),

  submittedFeedback: (interviewId) =>
    api.get(`/recruitment/interviews/${interviewId}/feedback`).then(unwrap),

  startFinalReview: (candidateId, comment = '') =>
    api
      .post(`/recruitment/candidates/${candidateId}/final-review`, { comment })
      .then(unwrap),

  recordFinalDecision: (candidateId, data) =>
    api
      .post(`/recruitment/candidates/${candidateId}/final-decision`, data)
      .then(unwrap),
};

export default recruitmentEvaluationService;
