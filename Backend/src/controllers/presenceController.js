// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 + 37.4 — PRESENCE CONTROLLER
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
//
//  37.4 — the controller wires the live store into the service so
//  getMyPresence + getTeamAvailability pick up each user's effective
//  live presence (Available / Away / Offline / Unknown). It also
//  publishes a `presence:changed` envelope after a manual mutation
//  (setMyStatus / setMyStatusMessage / setMyWorkLocation) so the
//  team page + other instances invalidate and refetch. The publish
//  is best-effort and NEVER throws up.
// ═══════════════════════════════════════════════════════════════════════════

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { sendPresenceError, PresenceError } from '../services/presence/presenceErrors.js';
import { presenceService } from '../services/presence/presenceService.js';
import { presenceTeamService } from '../services/presence/presenceTeamService.js';
import {
  updatePresenceTenantConfig,
} from '../services/presence/presenceTenantConfigService.js';
import {
  getPresenceLiveStore,
  presenceLiveStoreForConnection,
} from '../services/presence/presenceLiveStoreRegistry.js';
import {
  publishPresenceChanged,
} from '../services/presence/presenceBus.js';
import User from '../models/User.js';
import UserPresence from '../models/UserPresence.js';

// 37.4 — the live store is wired by the socket module at attach time
// (so a test that fakes the store can pass it through
// presenceLiveStoreRegistry). The controller calls the registry on
// every request, so the store can be swapped at runtime without
// restarting the controller.
const buildService = () => presenceService({ liveStore: getPresenceLiveStore() });
const buildTeamService = () =>
  presenceTeamService({
    UserModel: User,
    UserPresenceModel: UserPresence,
    liveStore: getPresenceLiveStore(),
  });

// The controller holds ONE service instance per process (37.1 house
// style). When the socket module swaps the live store at attach time,
// the service is rebuilt lazily on the next request. For hermetic
// tests the service can be substituted via the test seam below.
let service = buildService();
let teamService = buildTeamService();

// Test/inspection seam — tests can replace the service without
// touching the registry.
export const __setPresenceServiceForTests = (next) => {
  service = next;
};
export const __setPresenceTeamServiceForTests = (next) => {
  teamService = next;
};

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

// 37.4 — publish a best-effort `presence:changed` envelope. NEVER
// throws. The presence:changed envelope is published only when the
// returned snapshot's `presence` differs from the most-recent value
// the controller has seen. We compare to a tiny in-process cache
// (last-seen per user); the cache is process-local and is best-
// effort — if a different instance observed the previous value, the
// other instance publishes, and the envelope is the authoritative
// signal. The local cache exists only to suppress the
// "manual changed but live state happens to match" duplicate.
const lastSeenPresence = new Map();
const safePublishIfChanged = async ({ companyId, userId, before, after }) => {
  if (!companyId || !userId) return;
  if (!after || typeof after !== 'object') return;
  const newPresence = after.presence;
  const key = `${String(companyId)}:${String(userId)}`;
  if (lastSeenPresence.get(key) === newPresence) return;
  lastSeenPresence.set(key, newPresence);
  try {
    await publishPresenceChanged({
      companyId: String(companyId),
      userId: String(userId),
      presence: newPresence,
      presenceSource: after.presenceSource || 'manual',
      source: 'resolver',
    });
  } catch {
    /* publish NEVER throws up — the bus is best-effort */
  }
};

// Re-bind services on every request so a runtime store swap
// (e.g. socket attach) takes effect without a process restart.
const services = () => {
  service = buildService();
  teamService = buildTeamService();
  return { service, teamService };
};

export const getMe = asyncHandler(async (req, res) => {
  const { service: s } = services();
  // DB Logic - resolve via service
  const snapshot = await runWithPresenceError(
    () => s.getMyPresence({ companyId: req.companyId, userId: req.user._id }),
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
  const { teamService: ts } = services();

  // DB Logic - read via the team service.
  const payload = await runWithPresenceError(
    () =>
      ts.getTeamAvailability({
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
  const { service: s } = services();

  // DB Logic - service
  const snapshot = await runWithPresenceError(
    () =>
      s.setMyStatus({
        companyId: req.companyId,
        userId: req.user._id,
        status: status === undefined ? undefined : status,
        expiresAt,
      }),
    req,
    res,
  );

  // 37.4 — best-effort cross-instance invalidation.
  await safePublishIfChanged({
    companyId: req.companyId,
    userId: req.user._id,
    after: snapshot,
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Status updated',
    data: snapshot,
  });
});

export const putStatusMessage = asyncHandler(async (req, res) => {
  // Data from frontend
  const { message, expiresAt } = req.body || {};
  const { service: s } = services();

  // DB Logic - service
  const snapshot = await runWithPresenceError(
    () =>
      s.setMyStatusMessage({
        companyId: req.companyId,
        userId: req.user._id,
        message: message === undefined ? '' : message,
        expiresAt,
      }),
    req,
    res,
  );

  // 37.4 — status-message changes do not change effective PRESENCE
  // (only the visible status message). The envelope would be noise;
  // do not publish.

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Status message updated',
    data: snapshot,
  });
});

export const putWorkLocation = asyncHandler(async (req, res) => {
  // Data from frontend
  const { location, expiresAt } = req.body || {};
  const { service: s } = services();

  // DB Logic - service
  const snapshot = await runWithPresenceError(
    () =>
      s.setMyWorkLocation({
        companyId: req.companyId,
        userId: req.user._id,
        location: location === undefined ? undefined : location,
        expiresAt,
      }),
    req,
    res,
  );

  // 37.4 — work-location changes do not change effective PRESENCE
  // (only the work_location field on the snapshot). The team page
  // refetches the user row when its workLocation changes; that
  // happens in the frontend (TeamAvailabilityPage). No bus publish.

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