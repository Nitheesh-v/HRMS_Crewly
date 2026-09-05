// Phase 30.2 — Super Admin BGV catalogue management handlers.
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  configureBgvService,
  getCatalogueView,
} from '../services/bgv/bgvCatalogueService.js';

export const bgvCatalogueList = asyncHandler(async (req, res) => {
  // DB Logic - platform-scoped read of the five-product catalogue view.
  const data = await getCatalogueView();

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV catalogue fetched',
    data,
  });
});

export const bgvCatalogueUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { type } = req.params;
  const payload = req.body ?? {};

  // DB Logic - validated, audited, atomic upsert (backend price authority).
  const result = await configureBgvService({
    type: String(type || '').toUpperCase(),
    payload,
    actorId: req.user?._id,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message:
      result.action === 'BGV_CATALOGUE_CONFIGURED'
        ? 'BGV service configured'
        : 'BGV service updated',
    data: result,
  });
});
