// ─────────────────────────────────────────────────────────────
// Phase 29.3 — Salary Structures controller (thin layer)
//
// Authorization and tenant scoping happen in the route
// (protect → tenantContext → requirePermission → requireFeature).
// Every business rule lives in
// services/payroll/salaryStructureService.js + salaryStructureRules.js.
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import salaryStructureService from '../services/payroll/salaryStructureService.js';

export const listSalaryStructures = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;

  // DB Logic - DB logics
  const result = await salaryStructureService.listStructures({ companyId: req.companyId, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Salary structures fetched',
    data: result.structures,
    // The active components of THIS company travel with the list so the UI
    // can name and categorise every line without a second request (§7).
    meta: { ...(result.meta || {}), components: result.components },
  });
});

export const getSalaryStructure = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { structureId } = req.params;

  // DB Logic - DB logics
  const structure = await salaryStructureService.getStructure({
    companyId: req.companyId,
    structureId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Salary structure fetched', data: structure });
});

// §9 — live preview. Nothing is stored; this only visualises a sample gross.
export const previewSalaryStructure = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { items = [], gross = 0 } = req.body;

  // DB Logic - DB logics
  const preview = await salaryStructureService.previewStructure({
    companyId: req.companyId,
    items,
    gross,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Salary preview calculated', data: preview });
});

export const createSalaryStructure = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const payload = req.body;

  // DB Logic - DB logics
  const structure = await salaryStructureService.createStructure({
    companyId: req.companyId,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Salary structure created successfully.',
    data: structure,
  });
});

export const updateSalaryStructure = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { structureId } = req.params;
  const payload = req.body;

  // DB Logic - DB logics
  const { structure, versioned } = await salaryStructureService.updateStructure({
    companyId: req.companyId,
    structureId,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: versioned
      ? 'Salary structure saved as a new version. Previous history is unchanged.'
      : 'Salary structure updated successfully.',
    data: structure,
  });
});

export const setSalaryStructureStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { structureId } = req.params;
  const { status } = req.body;

  // DB Logic - DB logics
  const structure = await salaryStructureService.setStatus({
    companyId: req.companyId,
    structureId,
    status,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Salary structure ${structure.status.toLowerCase()} successfully.`,
    data: structure,
  });
});

export const cloneSalaryStructure = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { structureId } = req.params;
  const payload = req.body;

  // DB Logic - DB logics
  const structure = await salaryStructureService.cloneStructure({
    companyId: req.companyId,
    structureId,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Salary structure cloned successfully.',
    data: structure,
  });
});
