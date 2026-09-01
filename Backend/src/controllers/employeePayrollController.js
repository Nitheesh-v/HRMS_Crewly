// ─────────────────────────────────────────────────────────────
// Phase 29.4 — Employee Payroll Profile controller (thin layer)
//
// Authorization, tenant scoping and payroll-scope checks happen
// in the route (protect → tenantContext → requirePermission →
// payrollProfileAccess). Every business rule lives in
// services/payroll/employeePayrollService.js +
// employeePayrollRules.js.
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import employeePayrollService from '../services/payroll/employeePayrollService.js';

export const listPayrollProfiles = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;

  // DB Logic - DB logics
  const result = await employeePayrollService.listProfiles({ companyId: req.companyId, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Employee payroll profiles fetched',
    data: result.profiles,
    meta: {
      structures: result.structures,
      // Everyone the UI may open a payroll profile for (§5 / §19).
      employees: result.employees,
      withoutProfile: result.withoutProfile,
    },
  });
});

// §9 — live breakup preview. Display only: nothing is stored.
export const previewPayrollProfile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { structureId, monthlyGross } = req.body;

  // DB Logic - DB logics
  const preview = await employeePayrollService.previewProfile({
    companyId: req.companyId,
    structureId,
    monthlyGross,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Salary breakup calculated', data: preview });
});

export const getPayrollProfile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params;

  // DB Logic - DB logics
  const profile = await employeePayrollService.getProfile({
    companyId: req.companyId,
    employeeId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll profile fetched', data: profile });
});

// §5 / §7 / §15 — create the profile, or write a new salary revision.
export const savePayrollProfile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params;
  const payload = req.body;

  // DB Logic - DB logics
  const { profile, revision } = await employeePayrollService.saveProfile({
    companyId: req.companyId,
    employeeId,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: revision
      ? 'Salary revision saved. The previous salary is kept in history.'
      : 'Payroll profile saved successfully.',
    data: profile,
  });
});

// §14 — Draft / Active / On Hold / Suspended.
export const setPayrollProfileStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params;
  const { status } = req.body;

  // DB Logic - DB logics
  const profile = await employeePayrollService.setStatus({
    companyId: req.companyId,
    employeeId,
    status,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Payroll profile is now ${profile.payrollStatus.toLowerCase().replace('_', ' ')}.`,
    data: profile,
  });
});
