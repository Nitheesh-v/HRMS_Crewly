// ============================================================
// REFERRAL SERVICE — /api/referrals/*
//
// Posted jobs visible to every employee, for referral.
//   openings() — jobs currently published (the same "posted" filter the
//                public career page uses), referral-safe fields only.
//   refer()    — submit a candidate for one opening (jobCode-addressed).
//   mine()     — the caller's own referrals with the live pipeline stage.
// ============================================================
import api from './api';

const referralService = {
  openings: () => api.get('/referrals/openings'),
  mine: () => api.get('/referrals/mine'),
  refer: (jobCode, payload) => api.post(`/referrals/${jobCode}`, payload),
};

export default referralService;
