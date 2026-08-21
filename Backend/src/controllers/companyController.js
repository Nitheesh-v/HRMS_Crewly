// ─────────────────────────────────────────────────────────────
// Company profile — the name & address printed on payslips.
// ─────────────────────────────────────────────────────────────
import Company from '../models/Company.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

// GET /api/companies/my — any logged-in member can view
export const getMyCompany = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const company = await Company.findOne({ _id: companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Company profile',
    data: company,
  });
});

// PUT /api/companies/my — COMPANY_ADMIN only (checked in routes)
export const updateMyCompany = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const set = {};
  const careerFields = [
    'careerPortalEnabled',
    'careerAbout',
    'careerWebsite',
    'careerLocation',
  ];

  if (req.body.name !== undefined) set.name = req.body.name;

  careerFields.forEach((field) => {
    if (req.body[field] !== undefined) set[field] = req.body[field];
  });

  if (req.body.address) {
    for (const key of ['line', 'city', 'state', 'pincode']) {
      if (req.body.address[key] !== undefined) {
        set[`address.${key}`] = req.body.address[key];
      }
    }
  }

  // DB Logic - DB logics
  const company = await Company.findOneAndUpdate(
    { _id: req.companyId },
    { $set: set },
    { new: true, runValidators: true }
  );

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Company profile and career settings updated',
    data: company,
  });
});
