import Permission from "../models/Permission.js";
import CompanyRole, { SYSTEM_COMPANY_ROLES } from "../models/CompanyRole.js";
import User from "../models/User.js";
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_MATRIX,
  ROLE_LABELS,
} from "./permissionRegistry.js";
import { hasFeature } from "./subscriptionEngine.js";

const CACHE_TTL = 5 * 60 * 1000;

const permissionCache = new Map();
let ensurePermissionsPromise = null;

const cacheKey = (companyId, userId) => `${companyId}:${userId}`;

export const invalidatePermissionCache = ({ companyId, userId = null }) => {
  if (userId) {
    permissionCache.delete(cacheKey(companyId, userId));

    return;
  }

  const prefix = `${companyId}:`;

  for (const key of permissionCache.keys()) {
    if (key.startsWith(prefix)) {
      permissionCache.delete(key);
    }
  }
};

// Perf RCA — short-TTL in-process cache for the Permission metadata doc
// that requirePermission() reads on EVERY guarded request (1 Atlas RTT).
//
// Why safe:
// - Permission docs are GLOBAL metadata (not tenant data); they change at
//   deploy/migration time, and deploys restart the process anyway.
// - The grant decision itself (resolveUserPermissions) already caches for
//   5 minutes, so a 15s metadata TTL is strictly fresher than the grant
//   it guards. A runtime deactivation propagates within one TTL.
// - Mongo stays the source of truth; only lean reads are cached, and a
//   missing permission (null) caches as null so unknown names keep 403ing.
const permissionMetaCache = new Map();

const PERM_META_MIN_TTL_MS = 5000;
const PERM_META_MAX_TTL_MS = 60000;
const PERM_META_DEFAULT_TTL_MS = 15000;

export const getPermissionMetaCacheTtlMs = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.PERMISSION_METADATA_CACHE_TTL_MS));
  if (!Number.isFinite(parsed) || parsed <= 0) return PERM_META_DEFAULT_TTL_MS;
  return Math.min(PERM_META_MAX_TTL_MS, Math.max(PERM_META_MIN_TTL_MS, parsed));
};

export const getPermissionByName = async (
  name,
  { PermissionModel = Permission } = {},
) => {
  const key = String(name || '');
  if (!key) return null;

  const entry = permissionMetaCache.get(key);

  if (entry && Date.now() - entry.at <= getPermissionMetaCacheTtlMs()) {
    return entry.value;
  }

  const doc = await PermissionModel.findOne({
    name: key,
    isActive: true,
  }).lean();

  permissionMetaCache.set(key, { at: Date.now(), value: doc || null });

  if (permissionMetaCache.size > 500) {
    permissionMetaCache.delete(permissionMetaCache.keys().next().value);
  }

  return doc || null;
};

export const _resetPermissionMetaCacheForTests = () =>
  permissionMetaCache.clear();

// Fresh-deployment RBAC bootstrap: pre-bootstrap lookups can cache a
// null Permission doc (15s TTL) and 403 the first guarded requests even
// after the catalogue exists. A successful catalogue ensure clears the
// metadata cache so authorization immediately sees real documents.
// Mongo stays the source of truth; this only kills stale nulls.
export const resetPermissionMetaCache = _resetPermissionMetaCacheForTests;

export const ensurePermissions = async (
  { PermissionModel = Permission } = {},
) => {
  if (!ensurePermissionsPromise) {
    ensurePermissionsPromise = (async () => {
      try {
        await PermissionModel.bulkWrite(
          DEFAULT_PERMISSIONS.map((permission) => ({
            updateOne: {
              filter: { name: permission.name },
              update: { $setOnInsert: permission },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      } catch (error) {
        // Multi-instance startup: two API instances may run this exact
        // bulkWrite against the same empty collection concurrently. With a
        // unique index on name, the loser's upserts fail with E11000 —
        // that is CONVERGENCE (the winning instance created the docs),
        // not a failure. Any other error is real and rethrown.
        const writeErrors = error?.writeErrors
          ? [...error.writeErrors]
          : error?.code === 11000
            ? []
            : null;

        const allDuplicateKeys =
          writeErrors !== null &&
          writeErrors.every((writeError) => writeError?.code === 11000) &&
          (error?.code === 11000 || writeErrors.length > 0);

        if (!allDuplicateKeys) {
          throw error;
        }
      }

      // Always re-read after the write: this function's return value is
      // the authoritative current catalogue, so a restarted or replacement
      // database can never leak stale ObjectIds into role provisioning.
      const catalogue = await PermissionModel.find({
        isActive: true,
      }).lean();

      resetPermissionMetaCache();

      return catalogue;
    })().catch((error) => {
      ensurePermissionsPromise = null;
      throw error;
    });
  }

  return ensurePermissionsPromise;
};

export const _resetEnsurePermissionsForTests = () => {
  ensurePermissionsPromise = null;
};

// Increment only when new default permissions are introduced.
// Existing system roles are migrated once per version.
//   21 → 22 : 29.8 gave HR_MANAGER PAYROLL_PAYMENT_READ
//   22 → 23 : 29.9 gave HR_MANAGER and FINANCE_MANAGER PAYSLIP_READ
//   23 → 24 : 29.10 added PAYROLL_STATUTORY_FILING and gave
//             PAYROLL_ADMIN / FINANCE_MANAGER the statutory duties
//   26 → 27 : 31.1 added ATTENDANCE_POLICY_READ/_MANAGE/_ACTIVATE and gave
//             HR_MANAGER READ + MANAGE (activation stays admin-only)
//   27 → 28 : 31.3 added ATTENDANCE_LOCATION_READ/_MANAGE and gave
//             HR_MANAGER both
//   28 → 29 : 31.4 added ATTENDANCE_WORK_MODE_REQUEST (self-service)
//             and _REVIEW (MANAGER + HR_MANAGER scoped queue)
//   29 → 30 : 31.5 added ATTENDANCE_REGULARIZATION_REQUEST (self-service)
//             and _REVIEW (MANAGER + HR_MANAGER scoped queue)
//   30 → 31 : 31.8 added ATTENDANCE_OVERTIME_REQUEST (self-service)
//             and _REVIEW (MANAGER + HR_MANAGER scoped queue)
//   31 → 32 : 31.11 added ATTENDANCE_FINALIZATION_READ / _MANAGE /
//             _REOPEN (COMPANY_ADMIN + HR_MANAGER, company-level)
//   32 → 33 : 31.12 added ATTENDANCE_OPERATIONS_READ (HR_MANAGER, HR-only dashboard)
//   33 → 34 : 31.14 added ATTENDANCE_CAPTURE_MANAGE (HR_MANAGER, kiosk/QR/import)
//   34 → 35 : 31.15 added ATTENDANCE_ANALYTICS_READ (HR_MANAGER, reports & analytics)
//   35 → 36 : Fresh-database RBAC bootstrap fix. SUPPORT_UPDATE_SELF was
//             referenced by the self-service matrices and selfServiceRoutes
//             but was missing from the catalogue, so it was silently dropped
//             from every role; the catalogue now carries it and the version
//             migration $addToSet-grants it once to matrix-holding roles.
const SYSTEM_PERMISSION_VERSION = 36;

// Exported for bootstrap verification/tests — the value itself is owned
// by this module; bump it ONLY when the catalogue or default role
// matrices change (see the migration log above).
export const getSystemPermissionVersion = () => SYSTEM_PERMISSION_VERSION;

export const ensureCompanyRoles = async (
  companyId,
  createdBy = null,
  { fetchRoles = true, PermissionModel = Permission, CompanyRoleModel = CompanyRole } = {},
) => {
  // Guarantees the global Permission catalogue exists (idempotent,
  // multi-instance-safe) before any role provisioning reads it.
  await ensurePermissions({ PermissionModel });

  // Provisioning NEVER reuses a cached/memoized catalogue snapshot: role
  // documents must reference the CURRENT live Permission ObjectIds. A
  // process-lifetime memo can outlive the database it was read from (e.g.
  // a dropped-and-recreated database under a running API), and role ids
  // built from that memo dangle silently — populate() drops them and the
  // role resolves to ZERO effective permissions. One lean indexed read
  // per ensure call keeps every provisioned id live and correct.
  const permissions = await PermissionModel.find(
    { isActive: true },
    { _id: 1, name: 1 },
  ).lean();

  const permissionMap = Object.fromEntries(
    permissions.map((permission) => [permission.name, permission._id]),
  );

  // Perf: each role touches only its own document, so the five
  // upsert+migrate pairs run concurrently (~10 sequential Atlas
  // round-trips → ~2). Every write stays individually atomic and the
  // whole function stays idempotent, so a retry completes any role a
  // failed run did not reach — same guarantee as the old loop.
  const migrateRole = async (roleKey) => {
    const defaultNames = DEFAULT_ROLE_MATRIX[roleKey] || [];

    const defaultPermissionIds = defaultNames
      .map((name) => permissionMap[name])
      .filter(Boolean);

    let role;

    try {
      // Atomic upsert prevents two requests from creating
      // the same protected role simultaneously.
      role = await CompanyRoleModel.findOneAndUpdate(
        {
          companyId,
          code: roleKey,
        },
        {
          $setOnInsert: {
            companyId,

            name: ROLE_LABELS[roleKey] || roleKey,

            code: roleKey,

            description: `Protected ${ROLE_LABELS[roleKey] || roleKey} role`,

            permissions: defaultPermissionIds,

            systemRoleKey: roleKey,

            isSystemRole: true,
            isActive: true,

            permissionVersion: SYSTEM_PERMISSION_VERSION,

            createdBy,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      );
    } catch (error) {
      // Another concurrent request may have completed
      // the same unique upsert first.
      if (error.code !== 11000) {
        throw error;
      }

      role = await CompanyRoleModel.findOne({
        companyId,
        code: roleKey,
      });
    }

    if (!role) return false;

    const migrationSet = {
      permissionVersion: SYSTEM_PERMISSION_VERSION,
    };

    if (createdBy) {
      migrationSet.updatedBy = createdBy;
    }

    // Atomic migration:
    // - no document.save()
    // - no stale __v conflict
    // - existing custom permissions are preserved
    // - missing defaults are added only once
    const result = await CompanyRoleModel.updateOne(
      {
        _id: role._id,
        companyId,
        isSystemRole: true,

        $or: [
          {
            permissionVersion: {
              $lt: SYSTEM_PERMISSION_VERSION,
            },
          },
          {
            permissionVersion: {
              $exists: false,
            },
          },
        ],
      },
      {
        $addToSet: {
          permissions: {
            $each: defaultPermissionIds,
          },
        },

        $set: migrationSet,
      },
    );

    return result.modifiedCount > 0;
  };

  const migratedFlags = await Promise.all(
    SYSTEM_COMPANY_ROLES.map((roleKey) => migrateRole(roleKey)),
  );

  if (migratedFlags.some(Boolean)) {
    invalidatePermissionCache({
      companyId,
    });
  }

  // Perf: resolveUserPermissions (the hot caller) ignores this return
  // value and re-reads the single user role itself, so it passes
  // fetchRoles:false and skips the find-all-roles + populate-everything
  // round-trips entirely. List endpoints keep the default.
  if (!fetchRoles) return null;

  return CompanyRoleModel.find({
    companyId,
    isActive: true,
  })
    .populate("permissions")
    .lean();
};

const subscriptionFeatureFor = (permission) => {
  const mapping = {
    PAYROLL: "payroll",
    PAYROLL_SETUP: "payroll",
    // Phase 29.1 RBAC update — every payroll-family permission is gated
    // by the same `payroll` subscription feature.
    SALARY_COMPONENT: "payroll",
    SALARY_STRUCTURE: "payroll",
    EMPLOYEE_SALARY: "payroll",
    SALARY_REVISION: "payroll",
    PAYROLL_RUN: "payroll",
    PAYROLL_PAYMENT: "payroll",
    PAYROLL_STATUTORY: "payroll",
    PAYROLL_REPORT: "payroll",
    PAYSLIP: "payroll",
    RECRUITMENT: "recruitment",
    RECRUITMENT_ANALYTICS: "recruitment",
    BACKGROUND_VERIFICATION: "recruitment",
    BACKGROUND_VERIFICATION_SETTINGS: "recruitment",
    REQUISITION: "recruitment",
    CANDIDATE: "recruitment",
    INTERVIEW: "recruitment",
    INTERVIEW_FEEDBACK: "recruitment",
    OFFER: "recruitment",
    OFFER_TEMPLATE: "recruitment",
    PRE_ONBOARDING: "recruitment",
    PRE_ONBOARDING_DOCUMENT: "recruitment",
    PRE_ONBOARDING_SETTINGS: "recruitment",
    PERFORMANCE: "performance",
    REPORT: "reports",
  };

  return mapping[permission.resource];
};

export const permissionAllowedByPlan = async (companyId, permission) => {
  const feature = subscriptionFeatureFor(permission);

  if (!feature) return true;

  return hasFeature(companyId, feature);
};

export const getPermissionPlanAvailability = async (
  companyId,
  permissions = [],
) => {
  const features = [
    ...new Set(
      permissions
        .map((permission) => subscriptionFeatureFor(permission))
        .filter(Boolean),
    ),
  ];

  const featureRows = await Promise.all(
    features.map(async (feature) => [
      feature,
      await hasFeature(companyId, feature),
    ]),
  );
  const featureAvailability = Object.fromEntries(featureRows);

  return Object.fromEntries(
    permissions.map((permission) => {
      const feature = subscriptionFeatureFor(permission);

      return [
        permission.name,
        feature ? Boolean(featureAvailability[feature]) : true,
      ];
    }),
  );
};

const findUserRole = async (user, { CompanyRoleModel = CompanyRole } = {}) => {
  if (user.roleRef) {
    return CompanyRoleModel.findOne({
      _id: user.roleRef,
      companyId: user.companyId,
      isActive: true,
    }).populate("permissions");
  }

  return CompanyRoleModel.findOne({
    companyId: user.companyId,

    systemRoleKey: user.role,

    isActive: true,
  }).populate("permissions");
};

// Fresh-database bootstrap self-repair.
//
// ensureCompanyRoles provisions role documents with the CURRENT live
// Permission ObjectIds, but a role provisioned by an older buggy path (a
// catalogue memoized from a database that was later dropped/recreated)
// can hold DANGLING permission refs: populate() silently drops them, so
// the role resolves to zero effective permissions while the raw document
// looks fully populated and its permissionVersion already equals the
// current version — the normal version-gated migration never repairs it.
//
// Detection here is free: findUserRole ALREADY populated the role, so a
// populated-permission count below the authoritative matrix count proves
// dead references. Repair is additive-only ($addToSet with fresh ids —
// dead ids stay but populate to nothing) and touches ONLY system roles
// that no admin has ever edited (updatedBy === null). Custom roles and
// admin-tuned system roles are never rewritten.
const repairSystemRoleIfNeeded = async (
  role,
  { PermissionModel = Permission, CompanyRoleModel = CompanyRole } = {},
) => {
  if (!role?.isSystemRole || !role.systemRoleKey) return role;

  // An admin-curated permission set on a system role is tenant
  // customization — respected, never silently rewritten (§13).
  if (role.updatedBy) return role;

  const defaultNames = DEFAULT_ROLE_MATRIX[role.systemRoleKey] || [];

  if (!defaultNames.length) return role;

  const livePermissions = (role.permissions || []).filter(
    (permission) => permission?.name,
  );

  if (livePermissions.length >= defaultNames.length) return role;

  const catalogue = await PermissionModel.find(
    { isActive: true },
    { _id: 1, name: 1 },
  ).lean();

  const permissionMap = new Map(
    catalogue.map((permission) => [permission.name, permission._id]),
  );

  const freshIds = defaultNames
    .map((name) => permissionMap.get(name))
    .filter(Boolean);

  await CompanyRoleModel.updateOne(
    {
      _id: role._id,
      companyId: role.companyId,
      isSystemRole: true,
    },
    {
      $addToSet: {
        permissions: {
          $each: freshIds,
        },
      },

      $set: {
        permissionVersion: SYSTEM_PERMISSION_VERSION,
      },
    },
  );

  invalidatePermissionCache({ companyId: role.companyId });

  return CompanyRoleModel.findOne({
    _id: role._id,
    companyId: role.companyId,
    isActive: true,
  }).populate("permissions");
};

export const resolveUserPermissions = async (
  userOrId,
  { PermissionModel = Permission, CompanyRoleModel = CompanyRole } = {},
) => {
  const user =
    typeof userOrId === "object"
      ? userOrId
      : await User.findById(userOrId).populate(
          "permissionOverrides.permission",
        );

  if (!user || !user.companyId) {
    return {
      allowed: new Set(),
      denied: new Set(),
      role: null,
    };
  }

  const key = cacheKey(user.companyId, user._id);

  const cached = permissionCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // fetchRoles:false — the return value was always discarded here;
  // findUserRole below loads the one role this user needs.
  await ensureCompanyRoles(user.companyId, null, {
    fetchRoles: false,
    PermissionModel,
    CompanyRoleModel,
  });

  const resolvedRole = await findUserRole(user, { CompanyRoleModel });

  // Bootstrap self-repair (see repairSystemRoleIfNeeded) — normally a
  // no-op that costs nothing beyond the already-populated role.
  const role = await repairSystemRoleIfNeeded(resolvedRole, {
    PermissionModel,
    CompanyRoleModel,
  });

  const rolePermissions = new Set(
    (role?.permissions || []).map((permission) => permission.name),
  );

  const allowed = new Set(rolePermissions);

  const denied = new Set();

  (user.permissionOverrides || []).forEach((override) => {
    const name = override.permission?.name;

    if (!name) return;

    if (override.effect === "DENY") {
      denied.add(name);
      allowed.delete(name);
    }

    if (override.effect === "ALLOW" && !denied.has(name)) {
      allowed.add(name);
    }
  });

  // Explicit DENY always wins.
  denied.forEach((name) => allowed.delete(name));

  const value = {
    allowed,
    denied,
    role,
  };

  permissionCache.set(key, {
    value,

    expiresAt: Date.now() + CACHE_TTL,
  });

  return value;
};

export const hasPermission = async (user, permissionName, options = {}) => {
  const resolved = await resolveUserPermissions(user, options);

  return (
    !resolved.denied.has(permissionName) && resolved.allowed.has(permissionName)
  );
};

export const hasAnyPermission = async (user, permissionNames, options = {}) => {
  const resolved = await resolveUserPermissions(user, options);

  return permissionNames.some(
    (name) => !resolved.denied.has(name) && resolved.allowed.has(name),
  );
};

export const hasAllPermissions = async (
  user,
  permissionNames,
  options = {},
) => {
  const resolved = await resolveUserPermissions(user, options);

  return permissionNames.every(
    (name) => !resolved.denied.has(name) && resolved.allowed.has(name),
  );
};

export const getPermissionPayload = async (user, options = {}) => {
  const resolved = await resolveUserPermissions(user, options);

  return {
    role: resolved.role
      ? {
          id: resolved.role._id,

          name: resolved.role.name,

          code: resolved.role.code,

          isSystemRole: resolved.role.isSystemRole,
        }
      : null,

    permissions: [...resolved.allowed],

    deniedPermissions: [...resolved.denied],
  };
};
