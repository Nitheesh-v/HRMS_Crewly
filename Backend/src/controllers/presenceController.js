// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE CONTROLLER
//
//  THIN. Per the project house style:
//    Data from frontend → DB Logic → service → Data to frontend
//
//  Business rules live in services/presence/presenceService.js.
//  Request shape lives in validators/presence/presenceValidator.js.
//  The resolver lives in services/presence/presenceResolver.js.
//
//  Identity authority is req.companyId + req.user._id. NEVER req.body.
//  A presence row's identity comes from the auth middleware.
// ═══════════════════════════════════════════════════════════════════════════

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { sendPresenceError, PresenceError } from '../services/presence/presenceErrors.js';
import presenceServiceFactory from '../services/presence/presenceService.js';
import {
  getPresenceTenantConfigOrThrow,
  updatePresenceTenantConfig,
} from '../services/presence/presenceTenantConfigService.js';

const service = presenceServiceFactory();

// Helper that wraps a PresenceError throw into the project's response
// shape. Other errors fall through the shared error handler.
const runWithPresenceError = async (handler, req, res) => {
  try {
    return await handler(req, res);
  } catch (err) {
    if (err instanceof PresenceError) {
      return sendPresenceError(res, err);
    }
    throw err;
  }
};

export const getMe = asyncHandler(async (req, res) => {
  // DB Logic - resolve via service
  const snapshot = await runWithPresenceError(
    () => service.getMyPresence({ companyId: req.companyId, userId: req.user._id }),
    req,
    res,
  );

  // Data to frontend - response
  return ApiResponse.success(res, {
    message: 'Presence resolved',
    data: snapshot,
  });
});

export const putStatus = asyncHandler(async (req, res) => {
  // Data from frontend
  const { status, expiresAt } = req.body || {};

  // DB Logic - service
  const snapshot = await runWithPresenceError(
    () =>
      service.setMyStatus({
        companyId: req.companyId,
        userId: req.user._id,
        status: status === undefined ? undefined : status,
        expiresAt,
      }),
    req,
    res,
  );

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Status updated',
    data: snapshot,
  });
});

export const putStatusMessage = asyncHandler(async (req, res) => {
  // Data from frontend
  const { message, expiresAt } = req.body || {};

  // DB Logic - service
  const snapshot = await runWithPresenceError(
    () =>
      service.setMyStatusMessage({
        companyId: req.companyId,
        userId: req.user._id,
        message: message === undefined ? '' : message,
        expiresAt,
      }),
    req,
    res,
  );

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Status message updated',
    data: snapshot,
  });
});

export const putWorkLocation = asyncHandler(async (req, res) => {
  // Data from frontend
  const { location, expiresAt } = req.body || {};

  // DB Logic - service
  const snapshot = await runWithPresenceError(
    () =>
      service.setMyWorkLocation({
        companyId: req.companyId,
        userId: req.user._id,
        location: location === undefined ? undefined : location,
        expiresAt,
      }),
    req,
    res,
  );

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Work location updated',
    data: snapshot,
  });
});

export const getConfig = asyncHandler(async (req, res) => {
  // DB Logic - read tenant config
  const config = await runWithPresenceError(
    () => getPresenceTenantConfigOrThrow({ companyId: req.companyId }),
    req,
    res,
  );

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Presence tenant config',
    data: config,
  });
});

export const putConfig = asyncHandler(async (req, res) => {
  // Data from frontend
  const patch = req.body || {};

  // DB Logic - update tenant config
  const config = await runWithPresenceError(
    () =>
      updatePresenceTenantConfig({
        companyId: req.companyId,
        userId: req.user._id,
        patch,
      }),
    req,
    res,
  );

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Presence tenant config updated',
    data: config,
  });
});