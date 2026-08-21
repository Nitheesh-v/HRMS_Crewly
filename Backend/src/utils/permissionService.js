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

export const ensurePermissions = async () => {
  await Promise.all(
    DEFAULT_PERMISSIONS.map((permission) =>
      Permission.updateOne(
        {
          name: permission.name,
        },
        {
          $setOnInsert: permission,
        },
        {
          upsert: true,
        },
      ),
    ),
  );

  return Permission.find({
    isActive: true,
  }).lean();
};

// Increment only when new default permissions are introduced.
// Existing system roles are migrated once per version.
const SYSTEM_PERMISSION_VERSION = 5;
export const ensureCompanyRoles = async (companyId, createdBy = null) => {
  const permissions = await ensurePermissions();

  const permissionMap = Object.fromEntries(
    permissions.map((permission) => [permission.name, permission._id]),
  );

  let migrated = false;

  for (const roleKey of SYSTEM_COMPANY_ROLES) {
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

    if (!role) continue;

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

    if (result.modifiedCount > 0) {
      migrated = true;
    }
  }

  if (migrated) {
    invalidatePermissionCache({
      companyId,
    });
  }

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
    RECRUITMENT: "recruitment",
    REQUISITION: "recruitment",
    CANDIDATE: "recruitment",
    INTERVIEW: "recruitment",
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

  await ensureCompanyRoles(user.companyId);

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
