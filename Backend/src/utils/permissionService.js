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

export const ensurePermissions = async () => {
  if (!ensurePermissionsPromise) {
    ensurePermissionsPromise = (async () => {
      await Permission.bulkWrite(
        DEFAULT_PERMISSIONS.map((permission) => ({
          updateOne: {
            filter: { name: permission.name },
            update: { $setOnInsert: permission },
            upsert: true,
          },
        })),
        { ordered: false },
      );

      return Permission.find({
        isActive: true,
      }).lean();
    })().catch((error) => {
      ensurePermissionsPromise = null;
      throw error;
    });
  }

  return ensurePermissionsPromise;
};

// Increment only when new default permissions are introduced.
// Existing system roles are migrated once per version.
//   21 → 22 : 29.8 gave HR_MANAGER PAYROLL_PAYMENT_READ
//   22 → 23 : 29.9 gave HR_MANAGER and FINANCE_MANAGER PAYSLIP_READ
//   23 → 24 : 29.10 added PAYROLL_STATUTORY_FILING and gave
//             PAYROLL_ADMIN / FINANCE_MANAGER the statutory duties
const SYSTEM_PERMISSION_VERSION = 26;
export const ensureCompanyRoles = async (
  companyId,
  createdBy = null,
  { fetchRoles = true } = {},
) => {
  const permissions = await ensurePermissions();

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
      role = await CompanyRole.findOneAndUpdate(
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

      role = await CompanyRole.findOne({
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
    const result = await CompanyRole.updateOne(
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

  return CompanyRole.find({
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

const findUserRole = async (user) => {
  if (user.roleRef) {
    return CompanyRole.findOne({
      _id: user.roleRef,
      companyId: user.companyId,
      isActive: true,
    }).populate("permissions");
  }

  return CompanyRole.findOne({
    companyId: user.companyId,

    systemRoleKey: user.role,

    isActive: true,
  }).populate("permissions");
};

export const resolveUserPermissions = async (userOrId) => {
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
  await ensureCompanyRoles(user.companyId, null, { fetchRoles: false });

  const role = await findUserRole(user);

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

export const hasPermission = async (user, permissionName) => {
  const resolved = await resolveUserPermissions(user);

  return (
    !resolved.denied.has(permissionName) && resolved.allowed.has(permissionName)
  );
};

export const hasAnyPermission = async (user, permissionNames) => {
  const resolved = await resolveUserPermissions(user);

  return permissionNames.some(
    (name) => !resolved.denied.has(name) && resolved.allowed.has(name),
  );
};

export const hasAllPermissions = async (user, permissionNames) => {
  const resolved = await resolveUserPermissions(user);

  return permissionNames.every(
    (name) => !resolved.denied.has(name) && resolved.allowed.has(name),
  );
};

export const getPermissionPayload = async (user) => {
  const resolved = await resolveUserPermissions(user);

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
