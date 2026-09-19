import api from './api.js';

export const getPublicStats = () => api.get('/public/stats');
export const getPublicTestimonials = () => api.get('/public/testimonials');

const publicService = {
  getPublicStats,
  getPublicTestimonials,
};

export default publicService;
