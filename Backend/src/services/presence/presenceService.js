// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE SERVICE
//
//  Orchestrates reads / writes against:
//    · UserPresence (per-user durable prefs)
//    · PresenceTenantConfig (per-tenant policy)
//    · presenceResolver (the ONE precedence authority)
//
//  The service OWNS:
//    · the read/write shape
//    · policy checks (WFH self_declare / approval_required / disabled,
//      feature disabled for the tenant, work-location allowlist)
//    · the cache invalidation hook (none in 37.x — placeholder)
//
//  The service does NOT own:
//    · HTTP request shape (validators/presence/presenceValidator.js)
//    · business precedence (presenceResolver.js)
//    · tenant-config persistence (presenceTenantConfigService.js)
//
//  INJECTABLE MODELS
//    presenceService({ UserPresenceModel, CompanyModel, ... }) — every
//    Mongo interaction is the value of an injected seam. The hermetic
//    test fakes each one.
// ═══════════════════════════════════════════════════════════════════════════

import UserPresence from '../../models/UserPresence.js';
import { PresenceError, PRESENCE_ERROR_CODES } from './presenceErrors.js';
import {
  PRESENCE_MANUAL_VALUES,
  STATUS_MESSAGE_MAX_CHARS,
  WORK_LOCATION_VALUES,
  isWorkLocation,
} from './presenceConfig.js';
import { getPresenceTenantConfigOrThrow } from './presenceTenantConfigService.js';
import { resolvePresence } from './presenceResolver.js';

const trimMessage = (value) =>
  typeof value === 'string' ? value.trim() : '';

const parseExpiryOrThrow = (expiry) => {
  if (expiry === undefined || expiry === null) return null;
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
      'expiresAt must be an ISO date string',
    );
  }
  if (d.getTime() <= Date.now()) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.EXPIRY_IN_PAST,
      'expiresAt must be in the future',
    );
  }
  return d;
};

// Read the durable row (or null if none). Always carries companyId+userId.
const readUserPresence = async ({ companyId, userId, UserPresenceModel }) => {
  const M = UserPresenceModel || UserPresence;
  return M.findOne({ companyId, userId });
};

// Compose the durable row in-memory, optionally persisting it.
const upsertUserPresence = async ({
  companyId,
  userId,
  patch,
  UserPresenceModel,
}) => {
  const M = UserPresenceModel || UserPresence;
  return M.findOneAndUpdate(
    { companyId, userId },
    {
      $set: patch,
      $setOnInsert: { companyId, userId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

export const presenceService = (deps = {}) => {
  const UserPresenceModel = deps.UserPresenceModel || UserPresence;
  const tenantConfigReader =
    deps.tenantConfigReader ||
    ((args) => getPresenceTenantConfigOrThrow(args));

  // Reads the resolved presence for the caller. Always returns a frozen
  // snapshot from the resolver — never a half-built object.
  const getMyPresence = async ({ companyId, userId }) => {
    const config = await tenantConfigReader({ companyId });
    if (!config.enabled) {
      // Tenant presence disabled. Still return a snapshot — the UI
      // hides the controls; the API does not refuse the read because
      // the read is what tells the UI whether to show them.
      return resolvePresence({ durable: null, config, now: new Date() });
    }
    const durable = await readUserPresence({ companyId, userId, UserPresenceModel });
    return resolvePresence({ durable, config, now: new Date() });
  };

  // Set / clear manual status. The tenant kill switch is enforced here.
  // WFH / work-location policy is NOT handled here — that is the
  // work-location mutation below.
  const setMyStatus = async ({ companyId, userId, status, expiresAt }) => {
    const config = await tenantConfigReader({ companyId });
    if (!config.enabled) {
      throw PresenceError.forbidden(
        PRESENCE_ERROR_CODES.PRESENCE_DISABLED,
        'Presence is disabled for your company.',
      );
    }

    // status === null is the clear shape. expiresAt must not be sent
    // alongside it (the validator already rejected that — kept as a
    // belt-and-braces guard here in case a non-HTTP caller forgets).
    if (status === null) {
      if (expiresAt !== undefined && expiresAt !== null) {
        throw PresenceError.badRequest(
          PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
          'expiresAt must be omitted while clearing (status: null)',
        );
      }
      await upsertUserPresence({
        companyId,
        userId,
        patch: {
          manualStatus: null,
          manualStatusExpiresAt: null,
        },
        UserPresenceModel,
      });
      return getMyPresence({ companyId, userId });
    }

    if (!PRESENCE_MANUAL_VALUES.includes(status)) {
      throw PresenceError.badRequest(
        PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
        `status must be one of: ${PRESENCE_MANUAL_VALUES.join(', ')}, or null to clear`,
      );
    }

    const expiry = expiresAt === undefined ? null : parseExpiryOrThrow(expiresAt);

    await upsertUserPresence({
      companyId,
      userId,
      patch: {
        manualStatus: status,
        manualStatusExpiresAt: expiry,
      },
      UserPresenceModel,
    });

    return getMyPresence({ companyId, userId });
  };

  // Set / clear status message. The statusMessagesEnabled flag is the
  // only policy gate here.
  const setMyStatusMessage = async ({ companyId, userId, message, expiresAt }) => {
    const config = await tenantConfigReader({ companyId });
    if (!config.statusMessagesEnabled) {
      throw PresenceError.forbidden(
        PRESENCE_ERROR_CODES.STATUS_MESSAGES_DISABLED,
        'Status messages are disabled for your company.',
      );
    }

    // Clear shape: empty string.
    if (message === '') {
      await upsertUserPresence({
        companyId,
        userId,
        patch: {
          statusMessage: '',
          statusMessageExpiresAt: null,
        },
        UserPresenceModel,
      });
      return getMyPresence({ companyId, userId });
    }

    const trimmed = trimMessage(message);
    if (trimmed.length === 0) {
      throw PresenceError.badRequest(
        PRESENCE_ERROR_CODES.STATUS_MESSAGE_EMPTY_AFTER_TRIM,
        'message must contain at least one non-whitespace character',
      );
    }
    // Length check runs on the ORIGINAL trimmed length, BEFORE slice().
    // Otherwise a 200-char string would be silently truncated to 160 and
    // a too-long message would persist without error.
    if (trimmed.length > STATUS_MESSAGE_MAX_CHARS) {
      throw PresenceError.badRequest(
        PRESENCE_ERROR_CODES.STATUS_MESSAGE_TOO_LONG,
        `message must be at most ${STATUS_MESSAGE_MAX_CHARS} characters`,
      );
    }

    const expiry = expiresAt === undefined ? null : parseExpiryOrThrow(expiresAt);

    await upsertUserPresence({
      companyId,
      userId,
      patch: {
        statusMessage: trimmed,
        statusMessageExpiresAt: expiry,
      },
      UserPresenceModel,
    });

    return getMyPresence({ companyId, userId });
  };

  // Set / clear work location. Five separate guards:
  //   1. workLocationEnabled tenant flag
  //   2. work-location allowlist on the tenant config
  //   3. WFH mode = disabled → refuse wfh
  //   4. WFH mode = approval_required → refuse wfh (37.5 owns requests)
  //   5. workLocation === null → clear (always allowed)
  const setMyWorkLocation = async ({ companyId, userId, location, expiresAt }) => {
    const config = await tenantConfigReader({ companyId });

    if (location === null) {
      await upsertUserPresence({
        companyId,
        userId,
        patch: {
          workLocation: null,
          workLocationExpiresAt: null,
        },
        UserPresenceModel,
      });
      return getMyPresence({ companyId, userId });
    }

    if (!config.workLocationEnabled) {
      throw PresenceError.forbidden(
        PRESENCE_ERROR_CODES.WORK_LOCATION_DISABLED,
        'Work location is disabled for your company.',
      );
    }

    if (!isWorkLocation(location)) {
      throw PresenceError.badRequest(
        PRESENCE_ERROR_CODES.INVALID_WORK_LOCATION,
        `location must be one of: ${WORK_LOCATION_VALUES.join(', ')}, or null to clear`,
      );
    }

    const allowed = Array.isArray(config.allowedWorkLocations)
      ? config.allowedWorkLocations
      : [];

    if (!allowed.includes(location)) {
      throw PresenceError.forbidden(
        PRESENCE_ERROR_CODES.INVALID_WORK_LOCATION,
        `Work location "${location}" is not enabled for your company.`,
      );
    }

    if (location === 'wfh') {
      if (config.wfhMode === 'disabled') {
        throw PresenceError.forbidden(
          PRESENCE_ERROR_CODES.WFH_DISABLED,
          'Work From Home is disabled for your company.',
        );
      }
      if (config.wfhMode === 'approval_required') {
        // 37.5 owns the request / approval workflow. Until then, refuse
        // with a deterministic policy error. Do NOT silently activate.
        throw PresenceError.conflict(
          PRESENCE_ERROR_CODES.WFH_APPROVAL_REQUIRED,
          'WFH requires approval for your company. Submit a request instead.',
        );
      }
      // wfhMode === 'self_declare' — fall through.
    }

    const expiry = expiresAt === undefined ? null : parseExpiryOrThrow(expiresAt);

    await upsertUserPresence({
      companyId,
      userId,
      patch: {
        workLocation: location,
        workLocationExpiresAt: expiry,
      },
      UserPresenceModel,
    });

    return getMyPresence({ companyId, userId });
  };

  return {
    getMyPresence,
    setMyStatus,
    setMyStatusMessage,
    setMyWorkLocation,
  };
};

// Default factory uses the project's real models. The hermetic tests
// inject fakes via `presenceService({ UserPresenceModel: fake })`.
export default presenceService();