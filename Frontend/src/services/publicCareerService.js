import axios from 'axios';

const publicApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: false,
  headers: {
    Accept: 'application/json',
  },
});

const unwrap = (response) =>
  response?.data?.data ??
  response?.data ??
  response ??
  {};

publicApi.interceptors.response.use(
  (response) => {
    const body = response.data;

    if (body && typeof body === 'object' && 'data' in body) {
      return body.meta ? body : body.data;
    }

    return body;
  },
  (error) => {
    const normalized = new Error(
      error.response?.data?.message ||
      error.message ||
      'Career portal request failed'
    );
    normalized.status = error.response?.status;
    normalized.code = error.response?.data?.code;
    return Promise.reject(normalized);
  }
);

const publicCareerService = {
  header: (companySlug) =>
    publicApi
      .get(`/public/careers/${companySlug}`)
      .then(unwrap),

  jobs: async (companySlug, params = {}) => {
    const response = await publicApi.get(
      `/public/careers/${companySlug}/jobs`,
      { params }
    );

    if (Array.isArray(response)) {
      return { jobs: response, meta: {}, company: null };
    }

    return {
      jobs: Array.isArray(response?.data) ? response.data : [],
      meta: response?.meta || {},
      company: response?.meta?.company || null,
    };
  },

  filters: (companySlug) =>
    publicApi
      .get(`/public/careers/${companySlug}/filters`)
      .then(unwrap),

  job: (companySlug, jobCode) =>
    publicApi
      .get(`/public/careers/${companySlug}/jobs/${jobCode}`)
      .then(unwrap),

  apply: (companySlug, jobCode, formData) =>
    publicApi
      .post(
        `/public/careers/${companySlug}/jobs/${jobCode}/apply`,
        formData
      )
      .then(unwrap),
};

export default publicCareerService;
