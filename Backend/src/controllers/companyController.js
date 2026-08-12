// ─────────────────────────────────────────────────────────────
// Company profile — the name & address printed on payslips.
// ─────────────────────────────────────────────────────────────
import Company from '../models/Company.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

// GET /api/companies/my — any logged-in member can view
export const getMyCompany = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { message: 'Company profile', data: req.company });
});

// PUT /api/companies/my — COMPANY_ADMIN only (checked in routes)
export const updateMyCompany = asyncHandler(async (req, res) => {
  const set = {};
  if (req.body.name !== undefined) set.name = req.body.name;
  if (req.body.address) {
    for (const key of ['line', 'city', 'state', 'pincode']) {
      if (req.body.address[key] !== undefined) set[`address.${key}`] = req.body.address[key];
    }
  }
  const company = await Company.findOneAndUpdate(
    { _id: req.companyId },
    { $set: set },
    { new: true, runValidators: true }
  );
  return ApiResponse.success(res, {
    message: 'Company profile updated — new payslips will show this info',
    data: company,
  });
});