// ─────────────────────────────────────────────────────────────
// Phase 29.2 — Salary Components controller (thin layer)
//
// Authorization and tenant scoping happen in the route
// (protect → tenantContext → requirePermission → requireFeature).
// The controller only reads the request, calls the service and
// returns the response — every business rule lives in
// services/payroll/salaryComponentService.js + salaryComponentRules.js.
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import salaryComponentService from '../services/payroll/salaryComponentService.js';

export const listSalaryComponents = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;

  // DB Logic - DB logics
  const result = await salaryComponentService.listComponents({ companyId: req.companyId, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Salary components fetched',
    data: result.components,
    meta: result.meta,
  });
});

export const getSalaryComponent = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { componentId } = req.params;

  // DB Logic - DB logics
  const component = await salaryComponentService.getComponent({
    companyId: req.companyId,
    componentId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Salary component fetched', data: component });
});

export const getSalaryComponentDefaults = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const suggestions = await salaryComponentService.getDefaultSuggestions({ companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Default salary component suggestions fetched',
    data: suggestions,
  });
});

export const createSalaryDefaults = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const result = await salaryComponentService.createDefaults({
    companyId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.created.length
      ? `${result.created.length} default salary component(s) created`
      : 'All default salary components already exist',
    data: result,
  });
});

export const createSalaryComponent = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const payload = req.body;

  // DB Logic - DB logics
  const component = await salaryComponentService.createComponent({
    companyId: req.companyId,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Salary component created successfully.',
    data: component,
  });
});

export const updateSalaryComponent = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { componentId } = req.params;
  const payload = req.body;

  // DB Logic - DB logics
  const { component, versioned } = await salaryComponentService.updateComponent({
    companyId: req.companyId,
    componentId,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: versioned
      ? 'Salary component updated as a new version. Previous payroll history is unchanged.'
      : 'Salary component updated successfully.',
    data: component,
  });
});

export const setSalaryComponentStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { componentId } = req.params;
  const { status } = req.body;

  // DB Logic - DB logics
  const { component } = await salaryComponentService.setStatus({
    companyId: req.companyId,
    componentId,
    status,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message:
      component.status === 'ACTIVE'
        ? 'Salary component activated successfully.'
        : 'Salary component deactivated successfully.',
    data: component,
  });
});

export const duplicateSalaryComponent = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { componentId } = req.params;
  const payload = req.body;

  // DB Logic - DB logics
  const component = await salaryComponentService.duplicateComponent({
    companyId: req.companyId,
    componentId,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Salary component duplicated successfully.',
    data: component,
  });
});
