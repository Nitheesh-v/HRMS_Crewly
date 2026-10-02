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
import { presenceService } from '../services/presence/presenceService.js';
import { presenceTeamService } from '../services/presence/presenceTeamService.js';
import {
  updatePresenceTenantConfig,
} from '../services/presence/presenceTenantConfigService.js';
import User from '../models/User.js';
import UserPresence from '../models/UserPresence.js';

const service = presenceService();
const teamService = presenceTeamService({ UserModel: User, UserPresenceModel: UserPresence });

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

// ────────────────────────────────────────────────────────────────────
//  PHASE 37.3 — TEAM AVAILABILITY (read-only)
//
//  Frontend is gated by RequireRole roles={SENIORS}. The backend does
//  NOT re-implement role gating; it reuses the existing scope helper
//  (utils/scope.js) so an EMPLOYEE who somehow reaches this handler
//  will see only themselves, and the response shape is identical to
//  MANAGER/TEAM_LEAD — no side-channel by user class.
//
//  This handler is THIN: it parses the validated query (the validator
//  guarantees shape) and delegates everything else to the service.
// ────────────────────────────────────────────────────────────────────
export const getTeamAvailability = asyncHandler(async (req, res) => {
  // Data from frontend — already validated.
  const { search, presence, workLocation, page, limit } = req.query || {};

  // DB Logic - read via the team service.
  const payload = await runWithPresenceError(
    () =>
      teamService.getTeamAvailability({
        companyId: req.companyId,
        actor: req.user,
        search,
        presence,
        workLocation,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      }),
    req,
    res,
  );

  // Data to frontend - response.
  return ApiResponse.success(res, {
    message: 'Team availability resolved',
    data: payload,
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