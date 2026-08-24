import {
  getCareerFilters,
  getCareerHeader,
  getPublicJob,
  listPublicJobs,
} from '../services/publicCareerService.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

// GET /api/public/careers/:companySlug
export const publicCareerHeader = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    companySlug: req.params.companySlug,
  };

  // DB Logic - DB logics
  const data = await getCareerHeader(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Career portal fetched',
    data,
  });
});

// GET /api/public/careers/:companySlug/jobs
export const publicCareerJobs = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    companySlug: req.params.companySlug,
    query: req.query,
  };

  // DB Logic - DB logics
  const result = await listPublicJobs(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Published jobs fetched',
    data: result.jobs,
    meta: {
      ...result.meta,
      company: result.company,
    },
  });
});

// GET /api/public/careers/:companySlug/jobs/:jobCode
export const publicCareerJobDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    companySlug: req.params.companySlug,
    jobCode: req.params.jobCode,
  };

  // DB Logic - DB logics
  const data = await getPublicJob(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Published job fetched',
    data,
  });
});

// GET /api/public/careers/:companySlug/filters
export const publicCareerFilters = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    companySlug: req.params.companySlug,
  };

  // DB Logic - DB logics
  const data = await getCareerFilters(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Career filters fetched',
    data,
  });
});
