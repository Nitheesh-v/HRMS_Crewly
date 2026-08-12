import api from './api';

const companyService = {
  getMy: () => api.get('/companies/my'),
  updateMy: (payload) => api.put('/companies/my', payload),
};

export default companyService;