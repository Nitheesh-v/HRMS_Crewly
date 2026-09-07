import axios from 'axios';

// Public candidate BGV collection client — token-authorized, no employee
// session (same posture as the consent/offer/pre-onboarding portals).
const publicApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: false,
  headers: { Accept: 'application/json' },
});

publicApi.interceptors.response.use(
  (response) => response.data?.data ?? response.data,
  (error) => {
    const normalized = new Error(
      error.response?.data?.message || error.message || 'BGV collection is unavailable'
    );
    normalized.status = error.response?.status;
    normalized.missingRequirements = error.response?.data?.missingRequirements || null;
    return Promise.reject(normalized);
  }
);

const base = (secureToken) => `/public/candidate/bgv-collection/${encodeURIComponent(secureToken)}`;

const bgvCollectionService = {
  read: (secureToken) => publicApi.get(base(secureToken)),
  saveIdentity: (secureToken, input) => publicApi.post(`${base(secureToken)}/identity`, input),
  saveAddress: (secureToken, input) => publicApi.post(`${base(secureToken)}/address`, input),
  saveEducation: (secureToken, record) => publicApi.post(`${base(secureToken)}/education`, record),
  removeEducation: (secureToken, recordId) =>
    publicApi.delete(`${base(secureToken)}/education/${encodeURIComponent(recordId)}`),
  saveEmployment: (secureToken, record) => publicApi.post(`${base(secureToken)}/employment`, record),
  removeEmployment: (secureToken, recordId) =>
    publicApi.delete(`${base(secureToken)}/employment/${encodeURIComponent(recordId)}`),
  saveReference: (secureToken, record) => publicApi.post(`${base(secureToken)}/reference`, record),
  removeReference: (secureToken, recordId) =>
    publicApi.delete(`${base(secureToken)}/reference/${encodeURIComponent(recordId)}`),
  uploadFile: (secureToken, { category, recordId, file, onProgress }) => {
    const form = new FormData();
    form.append('category', category);
    if (recordId) form.append('recordId', recordId);
    form.append('document', file);
    return publicApi.post(`${base(secureToken)}/files`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (event) => {
        if (onProgress && event.total) {
          onProgress(Math.round((event.loaded * 100) / event.total));
        }
      },
    });
  },
  removeFile: (secureToken, fileId) =>
    publicApi.delete(`${base(secureToken)}/files/${encodeURIComponent(fileId)}`),
  fileDownloadUrl: (secureToken, fileId) =>
    `${import.meta.env.VITE_API_URL || '/api'}${base(secureToken)}/files/${encodeURIComponent(fileId)}`,
  submit: (secureToken) => publicApi.post(`${base(secureToken)}/submit`, {}),
};

export default bgvCollectionService;
