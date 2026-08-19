import Permission from '../models/Permission.js';
import {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permissionAllowedByPlan,
} from '../utils/permissionService.js';

const forbidden = (
  res,
  message =
    'You do not have permission to perform this action.'
) =>
  res.status(403).json({
    statusCode: 403,
    success: false,
    code:
      'PERMISSION_DENIED',
    message,
  });

const planDenied = (
  res,
  permission
) =>
  res.status(403).json({
    statusCode: 403,
    success: false,
    code:
      'FEATURE_NOT_AVAILABLE',
    message:
      'This permission belongs to a feature that is not available on your current subscription plan.',
    data: {
      permission,
      upgradeUrl:
        '/app/subscription',
    },
  });

const loadPermission = async (
  name
) =>
  Permission.findOne({
    name,
    isActive: true,
  }).lean();

export const requirePermission = (
  resourceOrName,
  action = null
) => {
  const permissionName =
    action
      ? `${resourceOrName}_${action}`
      : resourceOrName;

  return async (
    req,
    res,
    next
  ) => {
    try {
      if (!req.user) {
        return forbidden(
          res,
          'Authentication required.'
        );
      }

      if (
        req.user.role ===
        'SUPER_ADMIN'
      ) {
        return forbidden(
          res,
          'Platform roles cannot use customer-company permissions.'
        );
      }

      const permission =
        await loadPermission(
          permissionName
        );

      if (!permission) {
        return forbidden(
          res,
          `Permission ${permissionName} is not registered.`
        );
      }

      const planAllowed =
        await permissionAllowedByPlan(
          req.companyId,
          permission
        );

      if (!planAllowed) {
        return planDenied(
          res,
          permissionName
        );
      }

      const allowed =
        await hasPermission(
          req.user,
          permissionName
        );

      if (!allowed) {
        return forbidden(res);
      }

      req.requiredPermission =
        permissionName;

      next();
    } catch (error) {
      return res
        .status(500)
        .json({
          statusCode: 500,
          success: false,
          code:
            'PERMISSION_CHECK_FAILED',
          message:
            error.message,
        });
    }
  };
};

export const requireAnyPermission = (
  permissionNames
) =>
  async (req, res, next) => {
    try {
      const allowed =
        await hasAnyPermission(
          req.user,
          permissionNames
        );

      if (!allowed) {
        return forbidden(res);
      }

      next();
    } catch (error) {
      return res
        .status(500)
        .json({
          statusCode: 500,
          success: false,
          code:
            'PERMISSION_CHECK_FAILED',
          message:
            error.message,
        });
    }
  };

export const requireAllPermissions = (
  permissionNames
) =>
  async (req, res, next) => {
    try {
      const allowed =
        await hasAllPermissions(
          req.user,
          permissionNames
        );

      if (!allowed) {
        return forbidden(res);
      }

      next();
    } catch (error) {
      return res
        .status(500)
        .json({
          statusCode: 500,
          success: false,
          code:
            'PERMISSION_CHECK_FAILED',
          message:
            error.message,
        });
    }
  };