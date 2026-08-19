import mongoose from 'mongoose';
import Permission from '../models/Permission.js';
import CompanyRole, {
  SYSTEM_COMPANY_ROLES,
} from '../models/CompanyRole.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import {
  ensureCompanyRoles,
  ensurePermissions,
  getPermissionPayload,
  invalidatePermissionCache,
  permissionAllowedByPlan,
} from '../utils/permissionService.js';
import {
  hasFeature,
} from '../utils/subscriptionEngine.js';

const ok = (res, status, data, message) =>
  res.status(status).json({
    statusCode: status,
    success: true,
    data,
    message,
  });

const fail = (res, status, message, data = {}) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    message,
    data,
  });

const audit = async ({
  req,
  action,
  targetType,
  targetId,
  previousState = null,
  newState = null,
}) => {
  try {
    await AuditLog.create({
      companyId: req.companyId,
      actor: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: 200,
      ip: req.ip || '',
      targetType,
      targetId,
      previousValue: previousState,
      newValue: newState,
      metadata: {
        userAgent:
          req.headers['user-agent'] || '',
      },
    });
  } catch {
    // Audit failure does not block role administration.
  }
};

const normalizeRoleCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const roleForCompany = async (
  companyId,
  roleId
) => {
  if (
    !mongoose.Types.ObjectId.isValid(roleId)
  ) {
    return null;
  }

  return CompanyRole.findOne({
    _id: roleId,
    companyId,
  }).populate('permissions');
};

const resolvePermissions = async (
  permissionValues = []
) => {
  const ids = permissionValues.filter((value) =>
    mongoose.Types.ObjectId.isValid(value)
  );

  const names = permissionValues
    .filter(
      (value) =>
        !mongoose.Types.ObjectId.isValid(value)
    )
    .map((value) =>
      String(value).toUpperCase()
    );

  return Permission.find({
    isActive: true,

    $or: [
      { _id: { $in: ids } },
      { name: { $in: names } },
    ],
  });
};

const validatePlanPermissions = async (
  companyId,
  permissions
) => {
  const unavailable = [];

  for (const permission of permissions) {
    const allowed =
      await permissionAllowedByPlan(
        companyId,
        permission
      );

    if (!allowed) {
      unavailable.push(
        permission.name
      );
    }
  }

  return unavailable;
};

// ============================================================
// GET /api/permissions
// ============================================================

export const listPermissions = async (req, res) => {
  try {
    await ensurePermissions();

    const permissions = await Permission.find({
      isActive: true,
    })
      .sort('group resource action scope')
      .lean();

    const groups = {};

    for (const permission of permissions) {
      const available =
        await permissionAllowedByPlan(
          req.companyId,
          permission
        );

      const group =
        permission.group ||
        permission.resource;

      if (!groups[group]) {
        groups[group] = [];
      }

      groups[group].push({
        ...permission,
        available,
      });
    }

    return ok(
      res,
      200,
      {
        permissions,
        groups,
      },
      'Permissions'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// GET /api/permissions/me
// ============================================================

export const myPermissions = async (req, res) => {
  try {
    await ensureCompanyRoles(
      req.companyId
    );

    const data =
      await getPermissionPayload(
        req.user
      );

    return ok(
      res,
      200,
      data,
      'My permissions'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// GET /api/roles
// ============================================================

export const listRoles = async (req, res) => {
  try {
    await ensureCompanyRoles(
      req.companyId,
      req.user._id
    );

    const roles =
      await CompanyRole.find({
        companyId: req.companyId,
      })
        .populate('permissions')
        .sort({
          isSystemRole: -1,
          name: 1,
        })
        .lean();

    return ok(
      res,
      200,
      roles,
      'Company roles'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// POST /api/roles
// Custom roles require Advanced RBAC entitlement.
// ============================================================

export const createRole = async (req, res) => {
  try {
    const advancedRbac =
      await hasFeature(
        req.companyId,
        'advancedRbac'
      );

    if (!advancedRbac) {
      return fail(
        res,
        403,
        'Custom roles are not available on your current subscription plan.',
        {
          code:
            'FEATURE_NOT_AVAILABLE',
          feature:
            'advancedRbac',
          upgradeUrl:
            '/app/subscription',
        }
      );
    }

    const name =
      String(req.body.name || '').trim();

    if (name.length < 2) {
      return fail(
        res,
        400,
        'Role name is required'
      );
    }

    const code =
      normalizeRoleCode(
        req.body.code || name
      );

    if (
      SYSTEM_COMPANY_ROLES.includes(code)
    ) {
      return fail(
        res,
        400,
        'This role code is reserved for a protected system role'
      );
    }

    const permissions =
      await resolvePermissions(
        req.body.permissions || []
      );

    const unavailable =
      await validatePlanPermissions(
        req.companyId,
        permissions
      );

    if (unavailable.length) {
      return fail(
        res,
        403,
        'Some permissions are unavailable on the current subscription plan.',
        {
          code:
            'FEATURE_NOT_AVAILABLE',
          permissions:
            unavailable,
        }
      );
    }

    const role =
      await CompanyRole.create({
        companyId:
          req.companyId,

        name,
        code,

        description:
          req.body.description || '',

        permissions:
          permissions.map(
            (permission) =>
              permission._id
          ),

        isSystemRole: false,
        isActive: true,
        createdBy:
          req.user._id,
      });

    invalidatePermissionCache({
      companyId:
        req.companyId,
    });

    await audit({
      req,
      action: 'ROLE_CREATED',
      targetType: 'CompanyRole',
      targetId: role._id,
      newState:
        role.toObject(),
    });

    return ok(
      res,
      201,
      role,
      'Role created'
    );
  } catch (error) {
    return fail(
      res,
      error.code === 11000
        ? 409
        : 500,
      error.code === 11000
        ? 'Role name or code already exists'
        : error.message
    );
  }
};

// ============================================================
// GET /api/roles/:roleId
// ============================================================

export const getRole = async (req, res) => {
  try {
    const role =
      await roleForCompany(
        req.companyId,
        req.params.roleId
      );

    if (!role) {
      return fail(
        res,
        404,
        'Role not found'
      );
    }

    return ok(
      res,
      200,
      role,
      'Role'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PATCH /api/roles/:roleId
// System role name/code cannot be changed.
// ============================================================

export const updateRole = async (req, res) => {
  try {
    const role =
      await CompanyRole.findOne({
        _id: req.params.roleId,
        companyId:
          req.companyId,
      });

    if (!role) {
      return fail(
        res,
        404,
        'Role not found'
      );
    }

    const previous =
      role.toObject();

    if (!role.isSystemRole) {
      if (req.body.name !== undefined) {
        role.name =
          String(req.body.name).trim();
      }

      if (req.body.code !== undefined) {
        const code =
          normalizeRoleCode(
            req.body.code
          );

        if (
          SYSTEM_COMPANY_ROLES.includes(
            code
          )
        ) {
          return fail(
            res,
            400,
            'Protected role code cannot be used'
          );
        }

        role.code = code;
      }

      if (
        req.body.isActive !== undefined
      ) {
        role.isActive =
          req.body.isActive === true;
      }
    }

    if (
      req.body.description !== undefined
    ) {
      role.description =
        req.body.description;
    }

    role.updatedBy =
      req.user._id;

    await role.save();

    invalidatePermissionCache({
      companyId:
        req.companyId,
    });

    await audit({
      req,
      action: 'ROLE_UPDATED',
      targetType: 'CompanyRole',
      targetId: role._id,
      previousState: previous,
      newState:
        role.toObject(),
    });

    return ok(
      res,
      200,
      role,
      'Role updated'
    );
  } catch (error) {
    return fail(
      res,
      error.code === 11000
        ? 409
        : 500,
      error.code === 11000
        ? 'Role name or code already exists'
        : error.message
    );
  }
};

// ============================================================
// POST /api/roles/:roleId/duplicate
// ============================================================

export const duplicateRole = async (req, res) => {
  try {
    const advancedRbac =
      await hasFeature(
        req.companyId,
        'advancedRbac'
      );

    if (!advancedRbac) {
      return fail(
        res,
        403,
        'Custom roles are not available on your current plan'
      );
    }

    const source =
      await CompanyRole.findOne({
        _id: req.params.roleId,
        companyId:
          req.companyId,
      });

    if (!source) {
      return fail(
        res,
        404,
        'Role not found'
      );
    }

    const name =
      String(
        req.body.name ||
          `${source.name} Copy`
      ).trim();

    const role =
      await CompanyRole.create({
        companyId:
          req.companyId,

        name,

        code:
          normalizeRoleCode(name),

        description:
          req.body.description ||
          `Copied from ${source.name}`,

        permissions:
          source.permissions,

        isSystemRole: false,
        isActive: true,
        createdBy:
          req.user._id,
      });

    await audit({
      req,
      action:
        'ROLE_CREATED',

      targetType:
        'CompanyRole',

      targetId:
        role._id,

      newState:
        role.toObject(),
    });

    return ok(
      res,
      201,
      role,
      'Role duplicated'
    );
  } catch (error) {
    return fail(
      res,
      error.code === 11000
        ? 409
        : 500,
      error.code === 11000
        ? 'Duplicated role name already exists'
        : error.message
    );
  }
};

// ============================================================
// DELETE /api/roles/:roleId
// System roles cannot be deleted.
// Custom roles are deactivated instead of destroyed.
// ============================================================

export const deactivateRole = async (req, res) => {
  try {
    const role =
      await CompanyRole.findOne({
        _id: req.params.roleId,
        companyId:
          req.companyId,
      });

    if (!role) {
      return fail(
        res,
        404,
        'Role not found'
      );
    }

    if (role.isSystemRole) {
      return fail(
        res,
        403,
        'Protected system roles cannot be deactivated'
      );
    }

    const assignedUsers =
      await User.countDocuments({
        companyId:
          req.companyId,

        roleRef:
          role._id,

        status: 'ACTIVE',
      });

    if (assignedUsers > 0) {
      return fail(
        res,
        409,
        'Reassign users before deactivating this role',
        {
          assignedUsers,
        }
      );
    }

    const previous =
      role.toObject();

    role.isActive = false;
    role.updatedBy =
      req.user._id;

    await role.save();

    invalidatePermissionCache({
      companyId:
        req.companyId,
    });

    await audit({
      req,
      action:
        'ROLE_DEACTIVATED',

      targetType:
        'CompanyRole',

      targetId:
        role._id,

      previousState:
        previous,

      newState:
        role.toObject(),
    });

    return ok(
      res,
      200,
      role,
      'Role deactivated'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PUT /api/roles/:roleId/permissions
// ============================================================

export const updateRolePermissions = async (
  req,
  res
) => {
  try {
    const role =
      await CompanyRole.findOne({
        _id: req.params.roleId,
        companyId:
          req.companyId,
      }).populate('permissions');

    if (!role) {
      return fail(
        res,
        404,
        'Role not found'
      );
    }

    const permissions =
      await resolvePermissions(
        req.body.permissions || []
      );

    const unavailable =
      await validatePlanPermissions(
        req.companyId,
        permissions
      );

    if (unavailable.length) {
      return fail(
        res,
        403,
        'Some permissions are unavailable on the current subscription plan.',
        {
          code:
            'FEATURE_NOT_AVAILABLE',

          permissions:
            unavailable,
        }
      );
    }

    const previous = {
      permissions:
        role.permissions.map(
          (permission) =>
            permission.name
        ),
    };

    role.permissions =
      permissions.map(
        (permission) =>
          permission._id
      );

    role.updatedBy =
      req.user._id;

    await role.save();

    invalidatePermissionCache({
      companyId:
        req.companyId,
    });

    await audit({
      req,
      action:
        'ROLE_PERMISSIONS_UPDATED',

      targetType:
        'CompanyRole',

      targetId:
        role._id,

      previousState:
        previous,

      newState: {
        permissions:
          permissions.map(
            (permission) =>
              permission.name
          ),
      },
    });

    return ok(
      res,
      200,
      await role.populate(
        'permissions'
      ),
      'Role permissions updated'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PATCH /api/users/:userId/role
// ============================================================

export const assignUserRole = async (req, res) => {
  try {
    if (
      String(req.params.userId) ===
      String(req.user._id)
    ) {
      return fail(
        res,
        403,
        'You cannot change your own role'
      );
    }

    const [user, role] =
      await Promise.all([
        User.findOne({
          _id: req.params.userId,
          companyId:
            req.companyId,
        }),

        CompanyRole.findOne({
          _id: req.body.roleId,
          companyId:
            req.companyId,
          isActive: true,
        }),
      ]);

    if (!user) {
      return fail(
        res,
        404,
        'User not found'
      );
    }

    if (!role) {
      return fail(
        res,
        404,
        'Role not found'
      );
    }

    // Company Admin account cannot be demoted through
    // the normal role-assignment endpoint.
    if (
      user.role ===
      'COMPANY_ADMIN'
    ) {
      return fail(
        res,
        403,
        'Company Admin role is protected'
      );
    }

    const previous = {
      role: user.role,
      roleRef: user.roleRef,
    };

    user.roleRef =
      role._id;

    // Keep old route compatibility while APIs migrate
    // to permission middleware.
    user.role =
      role.systemRoleKey ||
      'EMPLOYEE';

    await user.save();

    invalidatePermissionCache({
      companyId:
        req.companyId,

      userId:
        user._id,
    });

    await audit({
      req,
      action:
        'USER_ROLE_ASSIGNED',

      targetType: 'User',
      targetId: user._id,
      previousState:
        previous,

      newState: {
        role: user.role,
        roleRef:
          user.roleRef,

        companyRole:
          role.code,
      },
    });

    return ok(
      res,
      200,
      {
        user: {
          id: user._id,
          name: user.name,
          role: user.role,
          roleRef:
            user.roleRef,
        },

        companyRole: {
          id: role._id,
          name: role.name,
          code: role.code,
        },
      },
      'User role assigned'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// GET /api/users/:userId/permissions
// ============================================================

export const userPermissions = async (req, res) => {
  try {
    const user =
      await User.findOne({
        _id: req.params.userId,
        companyId:
          req.companyId,
      })
        .populate(
          'roleRef'
        )
        .populate(
          'permissionOverrides.permission'
        );

    if (!user) {
      return fail(
        res,
        404,
        'User not found'
      );
    }

    const effective =
      await getPermissionPayload(
        user
      );

    return ok(
      res,
      200,
      {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          legacyRole:
            user.role,
          roleRef:
            user.roleRef,
        },

        overrides:
          user.permissionOverrides,

        effective,
      },
      'User permissions'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PUT /api/users/:userId/permissions
// Replaces user-specific ALLOW/DENY overrides.
// ============================================================

export const updateUserPermissions = async (
  req,
  res
) => {
  try {
    if (
      String(req.params.userId) ===
      String(req.user._id)
    ) {
      return fail(
        res,
        403,
        'You cannot change your own permissions'
      );
    }

    const user =
      await User.findOne({
        _id: req.params.userId,
        companyId:
          req.companyId,
      }).populate(
        'permissionOverrides.permission'
      );

    if (!user) {
      return fail(
        res,
        404,
        'User not found'
      );
    }

    if (
      user.role ===
      'COMPANY_ADMIN'
    ) {
      return fail(
        res,
        403,
        'Company Admin permissions are protected'
      );
    }

    const values =
      Array.isArray(
        req.body.overrides
      )
        ? req.body.overrides
        : [];

    const permissionValues =
      values.map(
        (override) =>
          override.permission
      );

    const permissions =
      await resolvePermissions(
        permissionValues
      );

    const permissionMap =
      Object.fromEntries(
        permissions.map(
          (permission) => [
            String(
              permission._id
            ),
            permission,
          ]
        )
      );

    permissions.forEach(
      (permission) => {
        permissionMap[
          permission.name
        ] = permission;
      }
    );

    const normalized = [];

    for (const override of values) {
      const permission =
        permissionMap[
          String(
            override.permission
          )
        ];

      if (!permission) {
        return fail(
          res,
          400,
          `Unknown permission: ${override.permission}`
        );
      }

      if (
        ![
          'ALLOW',
          'DENY',
        ].includes(
          override.effect
        )
      ) {
        return fail(
          res,
          400,
          'Override effect must be ALLOW or DENY'
        );
      }

      if (
        override.effect ===
        'ALLOW'
      ) {
        const planAllowed =
          await permissionAllowedByPlan(
            req.companyId,
            permission
          );

        if (!planAllowed) {
          return fail(
            res,
            403,
            `${permission.name} is unavailable on the current subscription plan`
          );
        }
      }

      normalized.push({
        permission:
          permission._id,

        effect:
          override.effect,

        grantedBy:
          req.user._id,

        reason:
          override.reason ||
          '',
      });
    }

    const previous =
      user.permissionOverrides.map(
        (override) => ({
          permission:
            override.permission
              ?.name,

          effect:
            override.effect,
        })
      );

    user.permissionOverrides =
      normalized;

    await user.save();

    invalidatePermissionCache({
      companyId:
        req.companyId,

      userId:
        user._id,
    });

    await audit({
      req,
      action:
        'USER_PERMISSION_GRANTED',

      targetType: 'User',
      targetId: user._id,

      previousState: {
        overrides:
          previous,
      },

      newState: {
        overrides:
          normalized.map(
            (override) => ({
              permission:
                String(
                  override.permission
                ),

              effect:
                override.effect,
            })
          ),
      },
    });

    return ok(
      res,
      200,
      await getPermissionPayload(
        user
      ),
      'User permission overrides updated'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// SUPER ADMIN READ-ONLY COMPANY ROLE VIEW
// Called only from protected /api/super-admin route.
// ============================================================

export const platformCompanyRoles = async (
  req,
  res
) => {
  try {
    const {
      companyId,
    } = req.params;

    if (
      !mongoose.Types.ObjectId.isValid(
        companyId
      )
    ) {
      return fail(
        res,
        400,
        'Invalid company id'
      );
    }

    await ensureCompanyRoles(
      companyId
    );

    const roles =
      await CompanyRole.find({
        companyId,
      })
        .populate(
          'permissions'
        )
        .sort({
          isSystemRole: -1,
          name: 1,
        })
        .lean();

    return ok(
      res,
      200,
      roles,
      'Company role configuration'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};